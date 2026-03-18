export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type LogModule = 'auth' | 'mail-proxy' | 'sse' | 'lifecycle' | 'party' | 'autonomy' | 'kanban' | 'chat' | 'server' | 'config' | 'shutdown';

const LEVEL_PRIORITY: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: LogModule;
  message: string;
  data?: Record<string, unknown>;
}

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[currentLevel];
}

function emit(entry: LogEntry): void {
  const line = JSON.stringify(entry);
  if (entry.level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export function log(level: LogLevel, module: LogModule, message: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  emit({
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
    ...(data ? { data } : {}),
  });
}

export const logger = {
  error: (module: LogModule, message: string, data?: Record<string, unknown>) => log('error', module, message, data),
  warn: (module: LogModule, message: string, data?: Record<string, unknown>) => log('warn', module, message, data),
  info: (module: LogModule, message: string, data?: Record<string, unknown>) => log('info', module, message, data),
  debug: (module: LogModule, message: string, data?: Record<string, unknown>) => log('debug', module, message, data),
};

/**
 * Express middleware for request logging.
 * Logs: method, path, status, duration, requestId.
 */
export function requestLogger() {
  return (req: any, res: any, next: () => void): void => {
    const start = performance.now();
    const originalEnd = res.end;

    res.end = function (...args: any[]) {
      const duration = Math.round(performance.now() - start);
      log('info', 'server', `${req.method} ${req.path} ${res.statusCode}`, {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: duration,
        request_id: req.requestId,
      });
      return originalEnd.apply(res, args);
    };

    next();
  };
}
