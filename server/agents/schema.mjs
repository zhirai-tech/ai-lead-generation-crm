/**
 * Minimal JSON schema validator (no third-party dependency).
 *
 * It intentionally supports only the node types used by the agent output
 * schemas: object / array / string / integer / number / boolean, plus
 * enum, minLength, maxLength, minimum, maximum, minItems and maxItems.
 * Unknown fields are tolerated (models occasionally add explanations) but
 * every required field, enum and numeric range is enforced strictly.
 */

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function charLength(value) {
  return [...value].length;
}

export function validateValue(value, schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: expected object, got ${describe(value)}`);
        return errors;
      }
      for (const key of schema.required || []) {
        if (value[key] === undefined || value[key] === null) errors.push(`${path}.${key}: required field is missing`);
      }
      for (const [key, subSchema] of Object.entries(schema.properties || {})) {
        if (value[key] === undefined || value[key] === null) continue;
        errors.push(...validateValue(value[key], subSchema, `${path}.${key}`));
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array, got ${describe(value)}`);
        return errors;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`${path}: expected at least ${schema.minItems} item(s)`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${path}: expected at most ${schema.maxItems} item(s)`);
      }
      if (schema.items) {
        value.forEach((item, index) => {
          errors.push(...validateValue(item, schema.items, `${path}[${index}]`));
        });
      }
      break;
    }
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${path}: expected string, got ${describe(value)}`);
        return errors;
      }
      const length = charLength(value);
      if (schema.minLength !== undefined && length < schema.minLength) {
        errors.push(`${path}: string is shorter than ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && length > schema.maxLength) {
        errors.push(`${path}: string is longer than ${schema.maxLength} characters`);
      }
      if (schema.enum && !schema.enum.includes(value)) {
        errors.push(`${path}: value must be one of ${schema.enum.join(' | ')}`);
      }
      break;
    }
    case 'integer': {
      if (!Number.isInteger(value)) {
        errors.push(`${path}: expected integer, got ${describe(value)}`);
        return errors;
      }
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
      break;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${path}: expected number, got ${describe(value)}`);
        return errors;
      }
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
      break;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') errors.push(`${path}: expected boolean, got ${describe(value)}`);
      break;
    }
    default:
      // Unknown node type: do not silently accept, but also do not crash.
      errors.push(`${path}: unsupported schema node type ${schema.type}`);
  }
  return errors;
}

/**
 * Validate a parsed model output against the role schema and a total size cap.
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateOutput(value, schema, { maxBytes = 120_000 } = {}) {
  if (!schema) return { ok: false, errors: ['$: no output schema registered for this role'] };
  const errors = validateValue(value, schema);
  if (errors.length === 0 && maxBytes) {
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(value));
    } catch {
      errors.push('$: output is not JSON serialisable');
    }
    if (size > maxBytes) errors.push(`$: output exceeds the ${maxBytes} byte limit`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Parse JSON from a model response. Tolerates markdown fences and leading
 * prose, which are common even when JSON mode is requested.
 */
export function parseJsonOutput(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { ok: false, error: '模型返回为空' };
  }
  let text = rawText.replace(/^\uFEFF/, '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // continue with a best-effort object extraction
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return { ok: true, value: JSON.parse(text.slice(start, end + 1)) };
    } catch {
      // fall through
    }
  }
  return { ok: false, error: '模型输出不是合法 JSON' };
}

export default { validateValue, validateOutput, parseJsonOutput };
