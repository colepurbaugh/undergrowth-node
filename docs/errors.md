# MQTT Error Handling
------------------------------------------------------------------
## Error Code Categories

Error codes follow this naming convention:
- `GENERAL_*`:  General errors applicable to any command
- `INFO_*`:     Errors specific to info/get
- `CONFIG_*`:   Errors specific to config operations
- `DATA_*`:     Errors specific to data operations
------------------------------------------------------------------
## Standard Error Response Format

```json
{
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:17.123Z",
  "requestId": "req-12345",  // If provided in the request
  "status": "error",
  "error": {
    "code": "ERROR_CODE_HERE",
    "message": "Human-readable error message",
    "details": {} // Optional additional information
  }
}
```
------------------------------------------------------------------

## General Errors

### GENERAL_MALFORMED_REQUEST
```json
{
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:17.123Z",
  "status": "error",
  "error": {
    "code": "GENERAL_MALFORMED_REQUEST",
    "message": "The request message is malformed or invalid JSON"
  }
}
```
Occurs when the node receives a message that cannot be parsed as valid JSON.

### GENERAL_INVALID_COMMAND
```json
{
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:17.123Z",
  "status": "error",
  "error": {
    "code": "GENERAL_INVALID_COMMAND",
    "message": "Unknown or unsupported command",
    "details": {
      "command": "unknown_command"
    }
  }
}
```
Returned when the node receives a command that isn't recognized.

### GENERAL_SYSTEM_ERROR
```json
{
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:17.123Z",
  "requestId": "req-12345",
  "status": "error",
  "error": {
    "code": "GENERAL_SYSTEM_ERROR",
    "message": "Internal system error occurred",
    "details": {
      "reason": "Database connection failure"
    }
  }
}
```
Indicates an internal error on the node that prevented processing the command.

### GENERAL_UNAUTHORIZED
```json
{
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:17.123Z",
  "status": "error",
  "error": {
    "code": "GENERAL_UNAUTHORIZED",
    "message": "Not authorized to perform this command"
  }
}
```
Returned when authentication is required but missing or invalid.

## Info Errors

### INFO_TEMPORARILY_UNAVAILABLE
```json
{
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:17.123Z",
  "status": "error",
  "error": {
    "code": "INFO_TEMPORARILY_UNAVAILABLE",
    "message": "System information temporarily unavailable",
    "details": {
      "reason": "System is initializing"
    }
  }
}
```
Occurs when the node cannot retrieve system information, typically during startup.

### INFO_PARTIAL_DATA
```json
{
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:17.123Z",
  "status": "error",
  "error": {
    "code": "INFO_PARTIAL_DATA",
    "message": "Only partial system information is available",
    "details": {
      "available": ["hostname", "ipAddress"],
      "unavailable": ["cpuTemp", "uptime"]
    }
  }
}
```
Returned when some system information components are available but others aren't.

## Config Errors

### CONFIG_TABLE_NOT_FOUND
```json
{
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:17.123Z",
  "status": "error",
  "error": {
    "code": "CONFIG_TABLE_NOT_FOUND",
    "message": "Configuration table does not exist",
    "details": {
      "table": "nonexistent_table"
    }
  }
}
```
Occurs when a request refers to a non-existent configuration table.

### CONFIG_KEY_NOT_FOUND
```json
{
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:17.123Z",
  "status": "error",
  "error": {
    "code": "CONFIG_KEY_NOT_FOUND",
    "message": "Configuration key does not exist",
    "details": {
      "table": "timezone",
      "key": "nonexistent_key"
    }
  }
}
```
Returned when a specific configuration key wasn't found in the specified table.

### CONFIG_INVALID_VALUE
```json
{
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:17.123Z",
  "status": "error",
  "error": {
    "code": "CONFIG_INVALID_VALUE",
    "message": "Invalid configuration value",
    "details": {
      "table": "timezone",
      "key": "timezone",
      "value": "Invalid/TimeZone",
      "reason": "Timezone not recognized"
    }
  }
}
```
Returned when trying to set a configuration with an invalid value.

### CONFIG_READ_ONLY
```json
{
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:17.123Z",
  "status": "error",
  "error": {
    "code": "CONFIG_READ_ONLY",
    "message": "Configuration is read-only",
    "details": {
      "table": "system_state",
      "key": "hardware_id"
    }
  }
}
```
Occurs when trying to modify a configuration value that's read-only.

### CONFIG_WRITE_FAILED
```json
{
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:17.123Z",
  "status": "error",
  "error": {
    "code": "CONFIG_WRITE_FAILED",
    "message": "Failed to write configuration",
    "details": {
      "table": "sensor_config",
      "key": "address",
      "reason": "Database error"
    }
  }
}
```
Indicates that the configuration update failed to save to the database.

## Data Errors

### DATA_INVALID_SEQUENCE_RANGE
```json
{
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:17.123Z",
  "requestId": "req-12345",
  "status": "error",
  "error": {
    "code": "DATA_INVALID_SEQUENCE_RANGE",
    "message": "Invalid sequence range",
    "details": {
      "startSequence": 2000,
      "endSequence": 1000,
      "reason": "End sequence must be greater than start sequence"
    }
  }
}
```
Returned when the requested sequence range is invalid.

### DATA_SEQUENCE_NOT_FOUND
```json
{
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:17.123Z",
  "requestId": "req-12345",
  "status": "error",
  "error": {
    "code": "DATA_SEQUENCE_NOT_FOUND",
    "message": "Sequence not found",
    "details": {
      "startSequence": 10000,
      "endSequence": 20000,
      "availableRange": {
        "min": 1,
        "max": 5000
      }
    }
  }
}
```
Occurs when the requested sequence range doesn't exist in the database.

### DATA_LIMIT_EXCEEDED
```json
{
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:17.123Z",
  "requestId": "req-12345",
  "status": "error",
  "error": {
    "code": "DATA_LIMIT_EXCEEDED",
    "message": "Requested data exceeds maximum allowed records",
    "details": {
      "requested": 10000,
      "maximum": 1000,
      "suggestion": "Use a smaller sequence range or set a lower limit"
    }
  }
}
```
Returned when the request would return more records than allowed by the system.

### DATA_DB_ERROR
```json
{
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:17.123Z",
  "requestId": "req-12345",
  "status": "error",
  "error": {
    "code": "DATA_DB_ERROR",
    "message": "Database error occurred while retrieving data",
    "details": {
      "reason": "Connection timeout"
    }
  }
}
```
Indicates a database error that prevented retrieving the requested data.

### DATA_MISSING_PARAMETERS
```json
{
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:17.123Z",
  "status": "error",
  "error": {
    "code": "DATA_MISSING_PARAMETERS",
    "message": "Required parameters missing",
    "details": {
      "missing": ["startSequence", "endSequence"],
      "received": {}
    }
  }
}
```
Returned when required parameters for data retrieval are missing.

