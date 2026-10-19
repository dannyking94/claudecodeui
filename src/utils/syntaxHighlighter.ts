import { PrismAsyncLight } from 'react-syntax-highlighter';

/**
 * Code-block highlighter shared by chat and the markdown preview.
 *
 * The full `Prism` build bundles every refractor grammar (~570 KB minified)
 * into the entry chunk. The async-light build loads the core and each
 * grammar on first use, rendering the same `<pre><code>` as plain text
 * until then, so the block's size does not change when colours arrive.
 */
export const SyntaxHighlighter = PrismAsyncLight;

/**
 * Aliases the full build resolved through refractor's registry. The async
 * build only has loaders for canonical grammar names, so without this
 * `ts`, `js`, `py`, `html`… would silently stay unhighlighted.
 * Generated from `refractor/lang/*.js` (`<grammar>.aliases`).
 */
const PRISM_LANGUAGE_ALIASES: Record<string, string> = {
  adoc: 'asciidoc',
  atom: 'markup',
  avs: 'avisynth',
  coffee: 'coffeescript',
  conc: 'concurnas',
  context: 'latex',
  cs: 'csharp',
  dockerfile: 'docker',
  dotnet: 'csharp',
  eta: 'ejs',
  g4: 'antlr4',
  gitignore: 'ignore',
  gni: 'gn',
  gv: 'dot',
  hbs: 'handlebars',
  hgignore: 'ignore',
  hs: 'haskell',
  html: 'markup',
  idr: 'idris',
  ino: 'arduino',
  jinja2: 'django',
  js: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  kum: 'kumir',
  mathematica: 'wolfram',
  mathml: 'markup',
  md: 'markdown',
  moon: 'moonscript',
  n4jsd: 'n4js',
  nb: 'wolfram',
  npmignore: 'ignore',
  objc: 'objectivec',
  objectpascal: 'pascal',
  pcode: 'peoplecode',
  purs: 'purescript',
  px: 'pcaxis',
  py: 'python',
  qasm: 'openqasm',
  qs: 'qsharp',
  razor: 'cshtml',
  rb: 'ruby',
  rbnf: 'bnf',
  rkt: 'racket',
  rpy: 'renpy',
  rq: 'sparql',
  rss: 'markup',
  shell: 'bash',
  shortcode: 'bbcode',
  smlnj: 'sml',
  sol: 'solidity',
  ssml: 'markup',
  svg: 'markup',
  tex: 'latex',
  ts: 'typescript',
  tsconfig: 'typoscript',
  uc: 'unrealscript',
  url: 'uri',
  uscript: 'unrealscript',
  webmanifest: 'json',
  wl: 'wolfram',
  xeoracube: 'xeora',
  xml: 'markup',
  yml: 'yaml',
};

export const resolvePrismLanguage = (language: string): string => {
  const normalized = language.toLowerCase();
  return PRISM_LANGUAGE_ALIASES[normalized] ?? normalized;
};
