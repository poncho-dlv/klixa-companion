function ts() {
  return new Date().toISOString();
}

function format(level, scope, msg, extra) {
  const base = `[${ts()}] ${level} [${scope}] ${msg}`;
  if (extra === undefined) return base;
  return `${base} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
}

export function createLogger(scope) {
  return {
    info: (msg, extra) => console.log(format('INFO', scope, msg, extra)),
    warn: (msg, extra) => console.warn(format('WARN', scope, msg, extra)),
    error: (msg, extra) => console.error(format('ERROR', scope, msg, extra)),
  };
}
