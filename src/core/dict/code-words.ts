/**
 * 内置“编程熟词”：代码块中标注生词（需求 v8）时，这些词按熟词处理、不高亮。
 *
 * 收录范围：
 * - 主流语言的关键字与内置类型（JS/TS、Python、Java/Kotlin、C/C++/C#、Go、Rust、Swift、PHP、Ruby、Shell、SQL）
 * - 代码里常见的缩写与简写（str、init、args、ctx、impl、idx…），它们多数不是英语单词，却可能与词书中的冷僻词同形
 *   （如 args/arg 与词典无关，但 sub、ref、tmp 会被误当作单词查释义）
 * - 只在代码中才有专门含义、在代码里高亮只会干扰的普通词（return、import、default、static、void…）
 *
 * 只对**代码上下文**（pre/code/语法高亮容器）生效，正文中的同名单词照常按词书判断。
 * 匹配用小写原词与标识符拆分后的子词（getElementById → get/element/by/id），engine 拆分后逐个调用 {@link isCodeKnownWord}。
 */
const KEYWORDS = [
  // 控制流 / 声明（跨语言通用）
  'if', 'else', 'elif', 'elsif', 'switch', 'case', 'default', 'for', 'foreach', 'while', 'do', 'loop', 'break', 'continue',
  'return', 'goto', 'yield', 'await', 'async', 'try', 'catch', 'except', 'finally', 'throw', 'throws', 'raise', 'rescue',
  'ensure', 'defer', 'go', 'select', 'match', 'when', 'unless', 'until', 'then', 'fi', 'esac', 'done', 'end', 'begin',
  'function', 'func', 'fun', 'fn', 'def', 'lambda', 'proc', 'sub', 'method', 'class', 'struct', 'enum', 'union', 'trait',
  'interface', 'impl', 'implements', 'extends', 'extend', 'inherit', 'abstract', 'override', 'virtual', 'final', 'sealed',
  'static', 'const', 'constexpr', 'let', 'var', 'val', 'mut', 'readonly', 'volatile', 'register', 'extern', 'inline',
  'public', 'private', 'protected', 'internal', 'package', 'module', 'namespace', 'import', 'export', 'from', 'as', 'use',
  'using', 'include', 'require', 'requires', 'typedef', 'typeof', 'instanceof', 'sizeof', 'type', 'typename', 'template',
  'new', 'delete', 'del', 'this', 'self', 'super', 'base', 'null', 'nil', 'none', 'undefined', 'void', 'true', 'false',
  'and', 'or', 'not', 'in', 'is', 'of', 'with', 'pass', 'global', 'nonlocal', 'assert', 'debugger', 'echo', 'print',
  'println', 'printf', 'sprintf', 'puts', 'local', 'export', 'declare', 'unsafe', 'crate', 'mod', 'pub', 'dyn', 'ref',
  'where', 'move', 'chan', 'map', 'range', 'make', 'append', 'len', 'cap', 'copy', 'panic', 'recover', 'synchronized',
  'transient', 'native', 'strictfp', 'operator', 'friend', 'explicit', 'implicit', 'mutable', 'noexcept', 'nullptr',
  'decltype', 'auto', 'signed', 'unsigned', 'short', 'long', 'double', 'float', 'int', 'char', 'bool', 'boolean', 'byte',
  'string', 'str', 'object', 'any', 'unknown', 'never', 'symbol', 'bigint', 'number', 'array', 'tuple', 'dict', 'list',
  'set', 'vec', 'option', 'some', 'ok', 'err', 'result', 'promise', 'future', 'task', 'void', 'unit', 'usize', 'isize',
  'uint', 'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64', 'float32', 'float64', 'rune',
  'keyof', 'infer', 'satisfies', 'declare', 'get', 'put', 'post', 'patch', 'head', 'options',
  // SQL
  'where', 'join', 'inner', 'outer', 'left', 'right', 'on', 'group', 'by', 'order', 'having', 'limit', 'offset', 'insert',
  'into', 'values', 'update', 'create', 'drop', 'alter', 'table', 'index', 'view', 'distinct', 'count', 'sum', 'avg',
  'min', 'max', 'asc', 'desc', 'like', 'between', 'exists', 'primary', 'key', 'foreign', 'references', 'constraint',
];

/** 常见缩写/简写（多数不是英语单词，或与冷僻词同形） */
const ABBREVIATIONS = [
  'args', 'arg', 'argv', 'argc', 'kwargs', 'params', 'param', 'opts', 'opt', 'init', 'ctor', 'dtor', 'impl', 'util',
  'utils', 'lib', 'libs', 'pkg', 'src', 'dst', 'dest', 'tmp', 'temp', 'buf', 'buff', 'ptr', 'idx', 'len', 'num', 'nums',
  'cnt', 'val', 'vals', 'obj', 'objs', 'arr', 'elem', 'el', 'elm', 'cfg', 'conf', 'config', 'ctx', 'env', 'envs', 'req',
  'res', 'resp', 'msg', 'msgs', 'err', 'errs', 'exc', 'cb', 'fn', 'fns', 'func', 'proc', 'pid', 'tid', 'uid', 'gid', 'id',
  'ids', 'uuid', 'guid', 'url', 'uri', 'urls', 'api', 'apis', 'sdk', 'cli', 'gui', 'ui', 'ux', 'db', 'sql', 'orm', 'dao',
  'dto', 'vo', 'io', 'os', 'fs', 'dir', 'dirs', 'cwd', 'pwd', 'path', 'ext', 'ns', 'ms', 'sec', 'usec', 'ts', 'dt',
  'tz', 'utc', 'iso', 'fmt', 'repr', 'eval', 'exec', 'sys', 'std', 'stdin', 'stdout', 'stderr', 'cin', 'cout', 'cerr',
  'endl', 'malloc', 'calloc', 'realloc', 'sizeof', 'memcpy', 'memset', 'strlen', 'strcpy', 'atoi', 'itoa', 'regex',
  'regexp', 'json', 'xml', 'yaml', 'yml', 'html', 'css', 'http', 'https', 'tcp', 'udp', 'ip', 'dns', 'ssl', 'tls',
  'ssh', 'ftp', 'cpu', 'gpu', 'ram', 'rom', 'mem', 'gc', 'jvm', 'jdk', 'jre', 'npm', 'pip', 'git', 'repo', 'repos',
  'diff', 'cmd', 'cmds', 'ops', 'auth', 'oauth', 'jwt', 'admin', 'sudo', 'chmod', 'chown', 'mkdir', 'rmdir', 'ls', 'cd',
  'cp', 'mv', 'rm', 'grep', 'sed', 'awk', 'curl', 'wget', 'tar', 'zip', 'env', 'dev', 'prod', 'qa', 'ci', 'cd', 'todo',
  'fixme', 'xxx', 'hack', 'deps', 'dep', 'impls', 'attr', 'attrs', 'prop', 'props', 'kwarg', 'enum', 'enums', 'bool',
  'bools', 'char', 'chars', 'str', 'strs', 'int', 'ints', 'iter', 'iters', 'gen', 'prev', 'cur', 'curr', 'nxt', 'pos',
  'lhs', 'rhs', 'min', 'max', 'abs', 'avg', 'sqrt', 'pow', 'exp', 'log', 'rand', 'seed', 'hash', 'md5', 'sha', 'enc',
  'dec', 'encode', 'decode', 'serialize', 'deserialize', 'async', 'sync', 'mutex', 'sem', 'tx', 'rx', 'ack', 'nack',
  'addr', 'src', 'img', 'imgs', 'btn', 'nav', 'div', 'span', 'href', 'onclick', 'stylesheet', 'webpack', 'vite',
  'eslint', 'tsconfig', 'dockerfile', 'readme', 'changelog', 'localhost', 'boolean', 'nullable', 'getter', 'setter',
  'callback', 'callbacks', 'runtime', 'namespace', 'middleware', 'plugin', 'plugins', 'webhook', 'endpoint', 'endpoints',
  'refactor', 'linter', 'lint', 'mixin', 'mixins', 'stdlib', 'printf', 'println', 'toString', 'tostring', 'len',
];

/** 小写编程熟词集合（只读） */
export const CODE_KNOWN_WORDS: ReadonlySet<string> = new Set([...KEYWORDS, ...ABBREVIATIONS].map((w) => w.toLowerCase()));

/** 是否为编程熟词（大小写不敏感）。engine 在代码上下文中对拆分后的每个子词调用 */
export function isCodeKnownWord(word: string): boolean {
  return CODE_KNOWN_WORDS.has(word.toLowerCase());
}
