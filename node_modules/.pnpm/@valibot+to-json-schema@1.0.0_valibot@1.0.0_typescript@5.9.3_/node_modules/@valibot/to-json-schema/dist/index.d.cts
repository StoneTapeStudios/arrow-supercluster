import { JSONSchema7 } from 'json-schema';
import * as v from 'valibot';

/**
 * JSON Schema conversion config type.
 */
interface ConversionConfig {
    /**
     * The policy for handling incompatible schemas and actions.
     */
    readonly errorMode?: 'throw' | 'warn' | 'ignore';
    /**
     * The schema definitions for constructing recursive schemas. If not
     * specified, the definitions are generated automatically.
     */
    readonly definitions?: Record<string, v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>;
}

/**
 * Converts a Valibot schema to the JSON Schema format.
 *
 * @param schema The Valibot schema object.
 * @param config The JSON Schema configuration.
 *
 * @returns The converted JSON Schema.
 */
declare function toJsonSchema(schema: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>, config?: ConversionConfig): JSONSchema7;

export { type ConversionConfig, toJsonSchema };
