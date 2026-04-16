// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useArrowClusters } from '../src/index';

// 1. MOCKING: Mock the arrow-supercluster engine to isolate the hook's behavior.
// We only want to test if our hook calls the engine correctly, not the engine itself.
vi.mock('arrow-supercluster', () => {
  return {
    ArrowClusterEngine: vi.fn().mockImplementation(() => {
      return {
        load: vi.fn(), 
        getClusters: vi.fn().mockReturnValue([]), 
      };
    }),
  };
});

describe('useArrowClusters Hook', () => {
  
  // Clear mock history before each test to prevent side effects
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Test 1: Edge Case
  it('should return nulls when table is not provided', () => {
    const { result } = renderHook(() =>
      useArrowClusters({ 
        table: null, 
        bounds: [0, 0, 10, 10], 
        zoom: 5 
      })
    );

    expect(result.current.supercluster).toBeNull();
    expect(result.current.clusters).toBeNull();
  });

  // Test 2: Happy Path
  it('should initialize engine and return clusters when valid data is provided', () => {
    const mockTable = {} as any; 
    const mockBounds: [number, number, number, number] = [10, 20, 30, 40];
    const mockZoom = 10;

    const { result } = renderHook(() =>
      useArrowClusters({
        table: mockTable,
        bounds: mockBounds,
        zoom: mockZoom,
      })
    );

    expect(result.current.supercluster).not.toBeNull();
    expect(result.current.clusters).toEqual([]);
  });

  // Test 3: Behavioral/Regression Test (PR Feedback)
  it('should pass custom idColumn to the engine.load function', () => {
    const mockTable = {} as any;
    const customId = 'custom_id_column'; 

    const { result } = renderHook(() =>
      useArrowClusters({
        table: mockTable,
        bounds: [0, 0, 10, 10],
        zoom: 5,
        idColumn: customId, 
      })
    );

    // Verify that the custom idColumn is correctly passed down to the engine's load method
    expect(result.current.supercluster?.load).toHaveBeenCalledWith(
      mockTable,     
      'geometry',    
      customId,      
      undefined      
    );
  });
});