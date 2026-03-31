export function success(data, operationCode, requestId, extras = {}) {
  const now = new Date().toISOString();
  return {
    success: true,
    message: extras.message || 'Operation completed successfully',
    operation_code: operationCode,
    time_stamp: now,
    request_id: requestId,
    data,
    meta: {
      version: '1.0',
      performance: extras.performance || null,
    },
  };
}

export function error(code, message, operationCode, requestId, details = null) {
  const now = new Date().toISOString();
  return {
    success: false,
    message,
    operation_code: operationCode,
    time_stamp: now,
    request_id: requestId,
    error: {
      code,
      message,
      details,
      support: { request_id: requestId, time_stamp: now },
    },
    meta: { version: '1.0' },
  };
}

const ERROR_STATUS = {
  SESSION_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  CLUSTER_NOT_FOUND: 404,
  AGENT_NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  VALIDATION_ERROR: 400,
  EXECUTION_TIMEOUT: 408,
  AUTONOMY_ALREADY_RUNNING: 409,
  EXECUTION_ERROR: 500,
  STORAGE_ERROR: 500,
  INTERNAL_ERROR: 500,
};

export function statusForCode(code) {
  return ERROR_STATUS[code] || 500;
}
