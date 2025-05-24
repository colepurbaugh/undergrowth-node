# MQTT Communication Protocol

## Version Overview

- **Version 1.0** (Current Test Run)
  - Basic MQTT communication framework
  - Server gets information from nodes
  - Server gets sensor data from nodes
  - Simple structure with minimal complexity

- **Version 2.0** (Future Implementation)
  - Configuration management (get/set)
  - Enhanced security features
  - Advanced QoS settings
  - Complex message validation

# Version 1.0 MQTT Communication

## [Server --> Node] Commands
undergrowth/server/commands/{nodeId}/{command}

{nodeId} is the unique identifier for each node
{command} is one of the following:
  - info/get    - Request system information
  - data/get    - Request sensor data from ug-data.db

## [Server <-- Node] Responses
undergrowth/nodes/{nodeId}/responses/{command}

- {nodeId} matches the node's identifier
- {command} reflects the command being responded to (same as above)

## Configuration Settings
undergrowth/server/commands/{nodeId}/config/set/{setting}

examples given node-123ABC server-456DEF

### <- INFO GET
```json
Server Command:
Topic: undergrowth/server/commands/node-ABC123/info/get
Payload: {} 

Node Response:
Topic: undergrowth/nodes/node-ABC123/responses/info/get
Payload: {
  "nodeId":         "node-ABC123",
  "timestamp":      "2023-06-15T14:32:17.123Z",
  "ipAddress":      "192.168.1.105",
  "hostname":       "node-ABC123",
  "uptime":         "3d 5h 12m",
  "systemTimezone": "America/Los_Angeles",
  "localValues":    14532,
  "cpuTemp":        "95.6°F (35.3°C)",
  "internetStatus": "Connected",
  "protocol_version": "1.0"
}
```

### <- DATA GET
```json
Server Command:
Topic: undergrowth/server/commands/node-ABC123/data/get
Payload: {
  "startSequence": 1000,
  "endSequence": 2000,
  "limit": 500,
  "requestId": "req-12345"  // For tracking the response
}

Node Response:
Topic: undergrowth/nodes/node-ABC123/responses/data/get
Payload: {
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:20.123Z",
  "requestId": "req-12345",
  "startSequence": 1000,
  "endSequence": 2000,
  "recordCount": 347,
  "data": [
    {
      "timestamp": "2023-06-15T10:00:00.000Z",
      "address": "0x38",
      "type": "temperature",
      "value": 72.5,
      "sequence_id": 1000
    },
    // Additional readings...
  ]
}
```
### Data Request Limits
- **Node limit**: 5,000 records maximum per request
- **Server limit**: 1,000 records maximum per request
- For larger datasets, implement sequential requests with pagination

### Server collection queue explained
Note: All server-to-node data transactions should use sequence-based queries, not time-based queries.

example given
- node-abc123 values = 30,000 (node values provided to server from info get)
    - node-abc123.db values = 5,000 (server has collected 5,000 values from node so far)
- node-def456 values = 20,000 
    - node-def456.db values = 6,000

node-abc123
local: 5,000
remote: 20,000
Queue:
[19,000-20,000] [18,000-19,000] [17,000-18,000] [16,000-17,000] [15,000-16,000]
[14,000-15,000] [13,000-14,000] [12,000-13,000] [11,000-12,000] [10,000-11,000] 
[9,000-10,000] [8,000-9,000] [7,000-8,000] [6,000-7,000]

node-def456
local: 6,000
remote: 20,000
Queue:
[19,000-20,000] [18,000-19,000] [17,000-18,000] [16,000-17,000] [15,000-16,000]
[14,000-15,000] [13,000-14,000] [12,000-13,000] [11,000-12,000] [10,000-11,000] 
[9,000-10,000] [8,000-9,000] [7,000-8,000] [6,000-7,000]

### Standardized Sensor Data Format

To ensure compatibility between nodes and server implementations, the following field names must be used consistently:

| Field Name      | Type    | Description                              | Example Value            |
|-----------------|---------|------------------------------------------|--------------------------| 
| timestamp       | string  | ISO8601 date/time                        | "2023-06-15T10:00:00Z"  |
| address         | string  | Sensor I2C address                       | "0x38"                  |
| type            | string  | Sensor reading type                      | "temperature"           |
| value           | number  | Sensor reading value                     | 72.5                    |
| sequence_id     | number  | Sequence ID for data ordering            | 1000                    |

For sensor response messages, the node sends:
```json
{
  "timestamp": "2023-06-15T14:32:17Z",
  "node_id": "node-ABC123",
  "readings": [
    {
      "sensor_id": "aht10_0x38",
      "type": "temperature",
      "value": 72.5,
      "unit": "°F"
    },
    {
      "sensor_id": "aht10_0x38",
      "type": "humidity",
      "value": 45.2,
      "unit": "%"
    }
  ]
}
```

For database storage and querying, these exact field names should be used in both the node's local database and the server's database schema.

> **IMPORTANT**: Do not rename fields (e.g., "type" to "reading_type") as this will break compatibility.

### Connection Management

#### Node Discovery and Connection
- Nodes use mDNS to discover the MQTT broker on the local network
- Nodes connect to broker with a unique client ID based on MAC address
- Nodes operate in passive mode - waiting for server commands
- Nodes should not publish messages except in response to server requests

#### Reconnection Behavior
- Nodes should attempt reconnection with exponential backoff
- Initial retry: 5 seconds
- Maximum retry interval: 30 minutes
- Nodes should continue operating in standalone mode during MQTT disconnection

# Protocol Versioning

- All messages should include a protocol version field: `"protocol_version": "1.0"`
- Clients should ignore fields they don't understand
- Increment the major version (1.0 → 2.0) for breaking changes
- Increment the minor version (1.0 → 1.1) for backward-compatible additions

### Server Database Implementation

- Store each node's data in a separate database file: `{node_id}-data.db`
- Use standardized field names in database schema: `timestamp`, `address`, `type`, `value`, `sequence_id`

### [Node Code]
Protocol Version Field
  - Add protocol_version: "1.0" to all outgoing MQTT messages
  - Implement in the MQTT controller's publish method to automatically inject this field
- Example: if (typeof message === 'object') message.protocol_version = "1.0";
#### Message Handling
- Implement handlers for all documented message types:
  - info/get - Return node system information
  - data/get - Return sensor data based on sequence or time range
#### Field Validation
  - For each incoming message type, validate required fields before - processing
  - Example for data requests: if (!message.requestId || !message.startSequence) return;
  - Return standardized error responses when validation fails
Include the original requestId in error responses

#### Timeouts

- Use built-in MQTT timeouts for connection handling (typically 30-60 seconds)
- Include a unique request ID in all request messages
- Server should track requests by ID without complex timeout logic
- For data retrievals, server can resend requests if no response after 30 seconds

### [Server Code]

#### Protocol Version Field
- Include *protocol_version: "1.0"* in all server-originated messages
- Validate protocol version in received messages from nodes
- Implement version compatibility checks for future protocol changes
#### Request Construction
- Use standardized request format with unique requestId for tracking
- Include all required fields per message type
Set appropriate QoS levels (QoS 1 for most messages)
- Don't use retain flag except for status messages
#### Response Handling
- Implement timeout handling for node responses
- Track requests by ID instead of relying on topic alone
- Gracefully handle missing or duplicate responses

#### Node Communication Queue
- Process one node at a time (sequential processing)
- Complete sync with current node before moving to next node
- Implement timeout mechanism (30-60 seconds) to skip unresponsive nodes
- Add nodes back to queue for retry after timeout
- Track sync status per node (fully synced, partially synced, not synced)
- Maintain simple first-in-first-out (FIFO) queue for Version 1.0

#### Server Sync Strategy
- Server should follow this sequence for each node:
  1. Request node info (`info/get`)
  2. Check node's last synced sequence ID
  3. Request data in batches from last sequence to current (`data/get`)
  4. Mark node as fully synced when caught up
- If node becomes unresponsive during sync:
  1. Record last successful sequence ID received
  2. Move to next node in queue
  3. Return to unfinished node after processing others
- New nodes discovered should be added to the end of the queue

### Data Request Parameters

#### Sequence-Based Data Request

```json
{
  // Required: 
  "requestId": "req-12345", // Unique ID for tracking responses
  // Required: 
  "startSequence": 1000, // First sequence ID to retrieve
  // Optional: 
  "endSequence": 2000, // Last sequence ID to retrieve
  // Optional:
  "limit": 1000 // Maximum records to return (1-5000)
}
```

### MQTT Topic Wildcards Reference

| Topic Pattern                                | Description                                    | Use Case                            |
|----------------------------------------------|------------------------------------------------|-------------------------------------|
| `undergrowth/nodes/+/responses/status`       | Status from all nodes                          | Monitor all node status             |
| `undergrowth/nodes/+/responses/sensors`      | Sensor data from all nodes                     | Collect all sensor readings         |
| `undergrowth/nodes/node-ABC123/responses/#`  | All response topics for a specific node        | Debug a specific node               |
| `undergrowth/server/commands/+/info/get`     | All info requests to any node                  | Audit system info requests          |
| `undergrowth/server/commands/+/data/get`     | All data retrieval requests                    | Track data sync activity            |


### Implementation Guidelines

#### Message Parsing Strategies
- Always validate the protocol_version field before processing
- Use try/catch blocks when parsing JSON messages
- Check for required fields before processing messages
- Use a default value for optional fields when missing
- Log parsing errors with details for troubleshooting

#### Broker Configuration Recommendations
- Configure QoS level 1 as the default for reliability
- Enable persistent sessions for the server
- Disable persistent sessions for nodes
- Set a reasonable keepalive interval (30-60 seconds)

### Server Implementation Checklist

For Version 1.0, the server needs to implement:

1. **MQTT Connection**
   - [ ] Connect to MQTT broker with appropriate settings
   - [ ] Use persistent sessions
   - [ ] Set QoS level 1 for all messages

2. **Topic Management**
   - [ ] Subscribe to all node response topics using wildcards
   - [ ] Publish commands to correct node-specific topics

3. **Message Formatting**
   - [ ] Add protocol_version: "1.0" to all outgoing messages
   - [ ] Include requestId in all data requests
   - [ ] Format all messages per documented examples

4. **Node Discovery**
   - [ ] Detect new nodes from status messages
   - [ ] Add discovered nodes to processing queue

5. **Queue Management**
   - [ ] Implement sequential node processing
   - [ ] Track sync status for each node
   - [ ] Implement timeout handling (30-60 seconds)
   - [ ] Return to unfinished nodes after cycle

6. **Data Synchronization**
   - [ ] Request node info first (`info/get`)
   - [ ] Request sensor data in batches (`data/get`)
   - [ ] Track last sequence ID per node
   - [ ] Store received data in server database

7. **Error Handling**
   - [ ] Detect and log communication errors
   - [ ] Implement retry mechanism for failed requests
   - [ ] Handle duplicate messages gracefully

# Version 2.0

## Features Planned for Version 2.0

### Security
Ignored for test run, will implement in version 2.0

### Configuration Commands
For version 2.0, the following configuration commands will be implemented:
- config/get - Request configuration from ug-config.db
- config/set - Update configuration in ug-config.db

Example:
#### <- CONFIG GET
```json
Server Command:
Topic: undergrowth/server/commands/node-ABC123/config/get
Payload: {
  "table": "sensor_config"  // Optional, to request specific table
}

Node Response:
Topic: undergrowth/nodes/node-ABC123/responses/config/get
Payload: {
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:18.456Z",
  "config": {
    "sensor_config": [
      { "address": "0x38", "type": "AHT10", "name": "Sensor 01", "enabled": 1 },
      { "address": "0x39", "type": "AHT10", "name": "Sensor 02", "enabled": 1 }
    ],
    "timezone": [
      { "key": "timezone", "value": "America/Los_Angeles" }
    ]
  }
}
```

#### -> CONFIG SET
```json
Server Command:
Topic: undergrowth/server/commands/node-ABC123/config/set
Payload: {
  "table": "timezone",
  "key": "timezone",
  "value": "America/New_York"
}

Node Response:
Topic: undergrowth/nodes/node-ABC123/responses/config/set
Payload: {
  "nodeId": "node-ABC123",
  "timestamp": "2023-06-15T14:32:19.789Z",
  "status": "success",
  "message": "Configuration updated",
  "table": "timezone",
  "key": "timezone",
  "value": "America/New_York"
}
```

### MQTT Topic Wildcards for Configuration

| Topic Pattern                                | Description                                    | Use Case                            |
|----------------------------------------------|------------------------------------------------|-------------------------------------|
| `undergrowth/server/requests/+/config/#`     | All configuration change requests              | Audit configuration changes         |

### Configuration Settings Reference

| Table Name      | Key                | Type    | Description                   | Example Value            |
|-----------------|--------------------|---------|------------------------------ |--------------------------|
| timezone        | timezone           | string  | Node's timezone               | "America/Los_Angeles"    |
| sensor_config   | address            | string  | Sensor I2C address            | "0x38"                   |
| sensor_config   | calibration_offset | float   | Temperature calibration       | 1.5                      |
| sensor_config   | calibration_scale  | float   | Temperature scaling factor    | 1.02                     |
| sensor_config   | enabled            | boolean | Enable/disable sensor         | true                     |
| pwm_states      | pin                | integer | GPIO pin number               | 12                       |
| pwm_states      | value              | integer | PWM value (0-100)             | 75                       |
| pwm_states      | enabled            | boolean | Enable/disable PWM output     | true                     |
| safety_state    | emergency_stop     | boolean | Emergency stop flag           | false                    |
| safety_state    | normal_enable      | boolean | Normal operation enable flag  | true                     |
| system_state    | mode               | integer | 0=automatic, 1=manual         | 0                        |

## Quality of Service (QoS)

MQTT provides three different Quality of Service (QoS) levels that determine the delivery guarantees for messages between clients and brokers:

### QoS Levels (0, 1, 2)

**QoS 0 (At most once)**
- Fire and forget - no guarantee of delivery
- No acknowledgment or storage
- Fastest and lowest overhead
- Use for: Non-critical telemetry, high-frequency data where occasional loss is acceptable

**QoS 1 (At least once)**
- Guaranteed delivery but with possible duplicates
- Message stored and acknowledged
- Messages are resent until acknowledgment
- Use for: Important messages where handling duplicates is possible
**QoS 2 (Exactly once)**
- Guaranteed delivery exactly once
- Four-part handshake ensures no duplicates
- Highest overhead and slowest performance
- Use for: Critical transactions, configuration changes, or when duplicates would cause problems

**Server to Node (Commands)**:

|   Command  | QoS Level |                         Justification                                   |
|------------|-----------|-------------------------------------------------------------------------|
| info/get   |     1     | Ensure command arrives, duplicates can be handled                       |
| config/get |     1     | Ensure command arrives, duplicates can be handled                       |
| config/set |     2     | Critical to ensure configuration changes happen exactly once            |
| data/get   |     1     | Ensure command arrives, repeat requests can be identified via requestId |

**Node to Server (Responses)**:

|      Response       | QoS Level |                             Justification                                      |
|---------------------|-----------|--------------------------------------------------------------------------------|
| info/get response   |     1     | Ensure system information is received                                          |
| config/get response |     1     | Important to receive configuration data                                        |
| config/set response |     1     | Important to confirm configuration changes                                     |
| data/get response   |     1     | Important to ensure data arrives, server can detect duplicates using requestId |

### Retain Flag

The MQTT "retain" flag stores the last message on a topic at the broker. When new clients subscribe, they immediately receive the most recent retained message.

**Guidelines for Retain Flag**:

- **DO NOT use retain** for most command/response messages in Undergrowth system
- **DO NOT use retain** for data transfer messages
- **DO use retain** for any Last Will and Testament (LWT) messages (node status)

All server commands to nodes and node responses should have the retain flag set to **false**. Using retain can lead to unexpected behavior where new subscribers receive old commands/responses.

### Implementation Notes

- The server should track message IDs and handle any duplicate messages resulting from QoS 1
- For data retrieval, always include a unique requestId to match responses with requests
- The client and server MQTT implementations should be configured to disable persistence of QoS=0 messages
- For QoS 2, be aware of higher resource usage and implement proper timeouts

