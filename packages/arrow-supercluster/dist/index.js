import KDBush from "kdbush";

//#region src/arrow-helpers.ts
/**
* Extract the raw Float64Array coordinate buffer from a GeoArrow Point column.
*
* GeoArrow Point encoding: FixedSizeList[2] of Float64
* Buffer layout: [lng0, lat0, lng1, lat1, ...]
*
* This accesses Arrow's internal buffer directly — zero copy.
* Single-chunk only in this version.
*/
function getCoordBuffer(geomCol) {
	const data = geomCol.data[0];
	if (data.children && data.children.length > 0) {
		const values = data.children[0].values;
		if (values instanceof Float64Array) return values;
	}
	const numRows = geomCol.length;
	const coords = new Float64Array(numRows * 2);
	for (let i = 0; i < numRows; i++) {
		const point = geomCol.get(i);
		if (point) {
			coords[i * 2] = point[0];
			coords[i * 2 + 1] = point[1];
		} else {
			coords[i * 2] = NaN;
			coords[i * 2 + 1] = NaN;
		}
	}
	return coords;
}

//#endregion
//#region src/mercator.ts
/**
* Mercator projection utilities — same math as Supercluster.
* Converts between lng/lat (WGS84) and Mercator x/y (0..1 range).
*/
const { fround } = Math;
/** Longitude to Mercator x (0..1) */
function lngX(lng) {
	return lng / 360 + .5;
}
/** Latitude to Mercator y (0..1) */
function latY(lat) {
	const sin = Math.sin(lat * Math.PI / 180);
	const y = .5 - .25 * Math.log((1 + sin) / (1 - sin)) / Math.PI;
	return y < 0 ? 0 : y > 1 ? 1 : y;
}
/** Mercator x (0..1) to longitude */
function xLng(x) {
	return (x - .5) * 360;
}
/** Mercator y (0..1) to latitude */
function yLat(y) {
	const y2 = (180 - y * 360) * Math.PI / 180;
	return 360 * Math.atan(Math.exp(y2)) / Math.PI - 90;
}

//#endregion
//#region src/arrow-cluster-engine.ts
const OFFSET_ZOOM = 2;
const OFFSET_ID = 3;
const OFFSET_PARENT = 4;
const OFFSET_NUM = 5;
const STRIDE = 6;
/**
* Arrow-native spatial clustering engine.
*
* Reimplements Supercluster's algorithm to work directly with Apache Arrow
* typed array buffers. No GeoJSON, no rendering opinion.
*/
var ArrowClusterEngine = class {
	trees = [];
	treeData = [];
	numPoints = 0;
	table = null;
	radius;
	extent;
	minZoom;
	maxZoom;
	minPoints;
	constructor(options = {}) {
		this.radius = options.radius ?? 40;
		this.extent = options.extent ?? 512;
		this.minZoom = options.minZoom ?? 0;
		this.maxZoom = options.maxZoom ?? 16;
		this.minPoints = options.minPoints ?? 2;
	}
	/**
	* Load an Arrow Table and build the spatial index.
	*/
	load(table, geometryColumn = "geometry", _idColumn = "id") {
		this.table = table;
		this.numPoints = table.numRows;
		const geomCol = table.getChild(geometryColumn);
		if (!geomCol) throw new Error(`Geometry column "${geometryColumn}" not found in Arrow Table`);
		const coordValues = getCoordBuffer(geomCol);
		const data = [];
		for (let i = 0; i < this.numPoints; i++) {
			const lng = coordValues[i * 2];
			const lat = coordValues[i * 2 + 1];
			if (lng === null || lat === null || Number.isNaN(lng) || Number.isNaN(lat)) continue;
			data.push(fround(lngX(lng)), fround(latY(lat)), Infinity, i, -1, 1);
		}
		let tree = this._createTree(data);
		this.trees[this.maxZoom + 1] = tree;
		this.treeData[this.maxZoom + 1] = data;
		for (let z = this.maxZoom; z >= this.minZoom; z--) {
			const nextData = this._cluster(tree, this.treeData[z + 1], z);
			tree = this._createTree(nextData);
			this.trees[z] = tree;
			this.treeData[z] = nextData;
		}
	}
	/**
	* Get clusters and individual points for a bounding box at a given zoom level.
	*/
	getClusters(bbox, zoom) {
		let minLng = ((bbox[0] + 180) % 360 + 360) % 360 - 180;
		const minLat = Math.max(-90, Math.min(90, bbox[1]));
		let maxLng = bbox[2] === 180 ? 180 : ((bbox[2] + 180) % 360 + 360) % 360 - 180;
		const maxLat = Math.max(-90, Math.min(90, bbox[3]));
		if (bbox[2] - bbox[0] >= 360) {
			minLng = -180;
			maxLng = 180;
		} else if (minLng > maxLng) {
			const eastern = this.getClusters([
				minLng,
				minLat,
				180,
				maxLat
			], zoom);
			const western = this.getClusters([
				-180,
				minLat,
				maxLng,
				maxLat
			], zoom);
			return this._mergeOutputs(eastern, western);
		}
		const z = this._limitZoom(zoom);
		const tree = this.trees[z];
		const data = this.treeData[z];
		if (!tree || !data) return this._emptyOutput();
		const resultIds = tree.range(lngX(minLng), latY(maxLat), lngX(maxLng), latY(minLat));
		const length = resultIds.length;
		const positions = new Float64Array(length * 2);
		const pointCounts = new Uint32Array(length);
		const ids = new Float64Array(length);
		const isCluster = new Uint8Array(length);
		for (let i = 0; i < length; i++) {
			const k = resultIds[i] * STRIDE;
			positions[i * 2] = xLng(data[k]);
			positions[i * 2 + 1] = yLat(data[k + 1]);
			pointCounts[i] = data[k + OFFSET_NUM];
			ids[i] = data[k + OFFSET_ID];
			isCluster[i] = data[k + OFFSET_NUM] > 1 ? 1 : 0;
		}
		return {
			positions,
			pointCounts,
			ids,
			isCluster,
			length
		};
	}
	/**
	* Get the immediate children of a cluster.
	*/
	getChildren(clusterId) {
		const originId = this._getOriginId(clusterId);
		const originZoom = this._getOriginZoom(clusterId);
		const tree = this.trees[originZoom];
		const data = this.treeData[originZoom];
		if (!tree || !data) return this._emptyOutput();
		if (originId * STRIDE >= data.length) return this._emptyOutput();
		const r = this.radius / (this.extent * Math.pow(2, originZoom - 1));
		const x = data[originId * STRIDE];
		const y = data[originId * STRIDE + 1];
		const neighborIds = tree.within(x, y, r);
		const children = [];
		for (const nid of neighborIds) {
			const k = nid * STRIDE;
			if (data[k + OFFSET_PARENT] === clusterId) children.push(nid);
		}
		const length = children.length;
		const positions = new Float64Array(length * 2);
		const pointCounts = new Uint32Array(length);
		const ids = new Float64Array(length);
		const isCluster = new Uint8Array(length);
		for (let i = 0; i < length; i++) {
			const k = children[i] * STRIDE;
			positions[i * 2] = xLng(data[k]);
			positions[i * 2 + 1] = yLat(data[k + 1]);
			pointCounts[i] = data[k + OFFSET_NUM];
			ids[i] = data[k + OFFSET_ID];
			isCluster[i] = data[k + OFFSET_NUM] > 1 ? 1 : 0;
		}
		return {
			positions,
			pointCounts,
			ids,
			isCluster,
			length
		};
	}
	/**
	* Get the Arrow row indices of all leaf points in a cluster.
	*/
	getLeaves(clusterId, limit = Infinity, offset = 0) {
		const indices = [];
		this._appendLeafIndices(indices, clusterId, limit, offset, 0);
		return indices;
	}
	/**
	* Get the zoom level at which a cluster expands into its children.
	*/
	getClusterExpansionZoom(clusterId) {
		let expansionZoom = this._getOriginZoom(clusterId) - 1;
		while (expansionZoom <= this.maxZoom) {
			const children = this.getChildren(clusterId);
			expansionZoom++;
			if (children.length !== 1) break;
			if (children.isCluster[0]) clusterId = children.ids[0];
			else break;
		}
		return expansionZoom;
	}
	/** Decode the zoom level from a cluster ID. */
	getOriginZoom(clusterId) {
		return this._getOriginZoom(clusterId);
	}
	/** Decode the origin index from a cluster ID. */
	getOriginId(clusterId) {
		return this._getOriginId(clusterId);
	}
	_getOriginZoom(clusterId) {
		return (clusterId - this.numPoints) % 32;
	}
	_getOriginId(clusterId) {
		return clusterId - this.numPoints >> 5;
	}
	_appendLeafIndices(result, clusterId, limit, offset, skipped) {
		const children = this.getChildren(clusterId);
		for (let i = 0; i < children.length; i++) if (children.isCluster[i]) if (skipped + children.pointCounts[i] <= offset) skipped += children.pointCounts[i];
		else {
			skipped = this._appendLeafIndices(result, children.ids[i], limit, offset, skipped);
			if (result.length >= limit) return skipped;
		}
		else if (skipped < offset) skipped++;
		else {
			result.push(children.ids[i]);
			if (result.length >= limit) return skipped;
		}
		return skipped;
	}
	/**
	* Cluster points at a given zoom level.
	* Matches Supercluster._cluster() exactly.
	*/
	_cluster(tree, data, zoom) {
		const r = this.radius / (this.extent * Math.pow(2, zoom));
		const nextData = [];
		for (let i = 0; i < data.length; i += STRIDE) {
			if (data[i + OFFSET_ZOOM] <= zoom) continue;
			data[i + OFFSET_ZOOM] = zoom;
			const x = data[i];
			const y = data[i + 1];
			const neighborIds = tree.within(x, y, r);
			const numPointsOrigin = data[i + OFFSET_NUM];
			let numPoints = numPointsOrigin;
			for (const neighborId of neighborIds) {
				const k = neighborId * STRIDE;
				if (data[k + OFFSET_ZOOM] > zoom) numPoints += data[k + OFFSET_NUM];
			}
			if (numPoints > numPointsOrigin && numPoints >= this.minPoints) {
				let wx = x * numPointsOrigin;
				let wy = y * numPointsOrigin;
				const id = ((i / STRIDE | 0) << 5) + (zoom + 1) + this.numPoints;
				for (const neighborId of neighborIds) {
					const k = neighborId * STRIDE;
					if (data[k + OFFSET_ZOOM] <= zoom) continue;
					data[k + OFFSET_ZOOM] = zoom;
					const numPoints2 = data[k + OFFSET_NUM];
					wx += data[k] * numPoints2;
					wy += data[k + 1] * numPoints2;
					data[k + OFFSET_PARENT] = id;
				}
				data[i + OFFSET_PARENT] = id;
				nextData.push(wx / numPoints, wy / numPoints, Infinity, id, -1, numPoints);
			} else {
				for (let j = 0; j < STRIDE; j++) nextData.push(data[i + j]);
				if (numPoints > 1) for (const neighborId of neighborIds) {
					const k = neighborId * STRIDE;
					if (data[k + OFFSET_ZOOM] <= zoom) continue;
					data[k + OFFSET_ZOOM] = zoom;
					for (let j = 0; j < STRIDE; j++) nextData.push(data[k + j]);
				}
			}
		}
		return nextData;
	}
	_createTree(data) {
		const numItems = data.length / STRIDE | 0;
		const tree = new KDBush(numItems, 64, Float32Array);
		for (let i = 0; i < data.length; i += STRIDE) tree.add(data[i], data[i + 1]);
		tree.finish();
		return tree;
	}
	_limitZoom(zoom) {
		return Math.max(this.minZoom, Math.min(Math.floor(+zoom), this.maxZoom + 1));
	}
	_emptyOutput() {
		return {
			positions: new Float64Array(0),
			pointCounts: new Uint32Array(0),
			ids: new Float64Array(0),
			isCluster: new Uint8Array(0),
			length: 0
		};
	}
	_mergeOutputs(a, b) {
		const length = a.length + b.length;
		const positions = new Float64Array(length * 2);
		const pointCounts = new Uint32Array(length);
		const ids = new Float64Array(length);
		const isCluster = new Uint8Array(length);
		positions.set(a.positions);
		positions.set(b.positions, a.length * 2);
		pointCounts.set(a.pointCounts);
		pointCounts.set(b.pointCounts, a.length);
		ids.set(a.ids);
		ids.set(b.ids, a.length);
		isCluster.set(a.isCluster);
		isCluster.set(b.isCluster, a.length);
		return {
			positions,
			pointCounts,
			ids,
			isCluster,
			length
		};
	}
};

//#endregion
export { ArrowClusterEngine };
//# sourceMappingURL=index.js.map