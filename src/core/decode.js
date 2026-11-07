/** @template T @typedef {(input: unknown, path: string) => T} Decoder */
/** @typedef {{code: 'INVALID_PROPOSAL', path: string, expected: string}} FieldError */
/** @template T @typedef {{kind: 'accepted', value: T} | {kind: 'rejected', reason: FieldError}} Decoded */

class InvalidField extends Error {
  /** @param {string} path @param {string} expected */
  constructor(path, expected) {
    super(path + ': expected ' + expected);
    /** @type {FieldError} */
    this.reason = { code: 'INVALID_PROPOSAL', path, expected };
  }
}

/** @param {string} path @param {string} expected @returns {never} */
export function invalid(path, expected) {
  throw new InvalidField(path, expected);
}

/** @template T @param {Decoder<T>} decoder @param {unknown} input @returns {Decoded<T>} */
export function decode(decoder, input) {
  try {
    return { kind: 'accepted', value: decoder(input, '$') };
  } catch (error) {
    if (!(error instanceof InvalidField)) throw error;
    return { kind: 'rejected', reason: error.reason };
  }
}

/** @template {string | number} T @param {...T} choices @returns {Decoder<T>} */
export function oneOf(...choices) {
  return (input, path) => choices.find(choice => choice === input) ?? invalid(path, choices.join(' | '));
}

/** @type {Decoder<string>} */
export const text = (input, path) => typeof input === 'string' ? input : invalid(path, 'a string');

/** @type {Decoder<string>} */
export const id = (input, path) => typeof input === 'string' && input.trim() ? input : invalid(path, 'a non-empty string');

/** @type {Decoder<number>} */
export const count = (input, path) => typeof input === 'number' && Number.isSafeInteger(input) && input >= 0
  ? input : invalid(path, 'a non-negative safe integer');

/** @type {Decoder<number>} */
export const measurement = (input, path) => typeof input === 'number' && Number.isFinite(input) && input >= 0
  ? input : invalid(path, 'a non-negative finite number');

/** @template T @param {Decoder<T>} item @returns {Decoder<T[]>} */
export const arrayOf = item => (input, path) => {
  if (!Array.isArray(input)) return invalid(path, 'an array');
  return Array.from(input, (value, index) => item(value, path + '[' + index + ']'));
};

/** @template T @param {Decoder<T>} item @returns {Decoder<T | undefined>} */
export const optional = item => (input, path) => input === undefined ? undefined : item(input, path);

/** @template T @param {Decoder<T>} item @returns {Decoder<T | null>} */
export const nullable = item => (input, path) => input === null ? null : item(input, path);

/**
 * @template {Record<string, Decoder<unknown>>} F
 * @param {F} fields
 * @returns {Decoder<{[K in keyof F]: ReturnType<F[K]>}>}
 */
export const record = fields => (input, path) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    return invalid(path, 'an object');
  }
  for (const field of Object.keys(input)) {
    if (!Object.hasOwn(fields, field)) invalid(path + '.' + field, 'a supported field');
  }
  const values = /** @type {Record<string, unknown>} */ (input);
  const entries = Object.entries(fields).map(([field, parse]) =>
    [field, parse(Object.hasOwn(values, field) ? values[field] : undefined, path + '.' + field)]);
  return /** @type {{[K in keyof F]: ReturnType<F[K]>}} */ (Object.fromEntries(entries));
};
