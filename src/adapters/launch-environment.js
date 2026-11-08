/** @param {Record<string, {fromEnv: string}> | undefined} references @param {NodeJS.ProcessEnv} environment */
export function launchEnvironment(references, environment) {
  const overrides = Object.entries(references ?? {}).map(([key, { fromEnv }]) => {
    if (!key || key.includes('=') || key.includes('\0')) {
      throw new TypeError('launch.env contains an invalid destination name');
    }
    const value = Object.hasOwn(environment, fromEnv) ? environment[fromEnv] : undefined;
    if (value === undefined || value.includes('\0')) {
      throw new TypeError(`launch.env.${key} references an unavailable or invalid environment value`);
    }
    return [key, value];
  });
  return { ...environment, ...Object.fromEntries(overrides) };
}
