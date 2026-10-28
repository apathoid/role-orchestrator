// Extensible, conservative candidate discovery. Filename conventions identify
// possible tests, NOT assertions, executed outcomes or coverage. Callers may
// supply additional repository-specific adapters; no language is privileged.
const ext = suffix => path => path.toLowerCase().endsWith(suffix);
const jsTest = /(?:^|\/)(?:__tests__\/)?[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const jsSource = /\.[cm]?[jt]sx?$/i;
const pyTest = /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/i;
const goTest = /_test\.go$/i;
const javaTest = /(?:^|\/)(?:Test[^/]+|[^/]+(?:Test|Tests|IT))\.java$/;
const dotnetTest = /(?:^|\/)[^/]+(?:Tests?|Specs?)\.cs$/;
const rubyTest = /(?:^|\/)(?:test_[^/]+\.rb|[^/]+_spec\.rb)$/i;
const phpTest = /(?:^|\/)[^/]+Test\.php$/;
const rustTest = /(?:^|\/)(?:tests?\/[\w.-]+|[^/]+_test)\.rs$/i;
const nativeTest = /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.(?:c|cc|cpp|cxx)$/i;
const ignore = /(?:^|\/)(?:node_modules|dist|build|target|vendor|coverage|__fixtures__|fixtures|__mocks__|mocks|\.git)\//i;

export const DEFAULT_TEST_DISCOVERY_ADAPTERS = Object.freeze([
  {id:'javascript-typescript',source:p=>jsSource.test(p) && !/\.(?:d|config)\.[cm]?[jt]sx?$/i.test(p),test:p=>jsTest.test(p)},
  {id:'python',source:ext('.py'),test:p=>pyTest.test(p) || /(?:^|\/)tests?\//i.test(p) && ext('.py')(p)},
  {id:'go',source:ext('.go'),test:p=>goTest.test(p)},
  {id:'java',source:ext('.java'),test:p=>javaTest.test(p) || /(?:^|\/)src\/test\//i.test(p)},
  {id:'csharp',source:ext('.cs'),test:p=>dotnetTest.test(p)},
  {id:'ruby',source:ext('.rb'),test:p=>rubyTest.test(p)},
  {id:'php',source:ext('.php'),test:p=>phpTest.test(p)},
  {id:'rust',source:ext('.rs'),test:p=>rustTest.test(p)},
  {id:'native',source:p=>/\.(?:c|cc|cpp|cxx)$/i.test(p),test:p=>nativeTest.test(p)},
]);

export function classifyTestCandidate(path, {adapters=DEFAULT_TEST_DISCOVERY_ADAPTERS}={}) {
  if (typeof path !== 'string' || path.startsWith('/') || path.split('/').includes('..') || ignore.test(path))
    return {kind:'ignored',adapter:null};
  for (const adapter of adapters) {
    if (typeof adapter?.id !== 'string' || typeof adapter?.test !== 'function' || typeof adapter?.source !== 'function')
      throw new TypeError('Invalid test discovery adapter');
    if (adapter.source(path)) return {kind:adapter.test(path)?'test':'production_candidate',adapter:adapter.id};
  }
  return {kind:'unknown',adapter:null};
}

const stem = path => path.split('/').at(-1)
  .replace(/\.(?:test|spec)(?=\.)|(?:_test|_spec|Test|Tests|IT)(?=\.)|^(?:test_|Test)/g,'')
  .replace(/\.[^.]+$/,'').toLowerCase();

export function associateTestCandidates(productionPath, testPaths, options={}) {
  const target=stem(productionPath);
  // The basename alone is weak evidence; retain the association kind.
  return testPaths.filter(path=>stem(path)===target).map(path=>({path,
    association:'HEURISTIC_BASENAME_ONLY',assertionEvidence:'NOT_VERIFIED'}));
}
