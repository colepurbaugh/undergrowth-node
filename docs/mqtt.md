
### MQTT Communication

## [Server --> Node] Commands
undergrowth/server/commands/{nodeId}/{command}
    {nodeId} is the unique identifier for each node
    {command} is one of the following:
        info/get    - Request system information
        config/get  - Request configuration from ug-config.db
        config/set  - Update configuration in ug-config.db
        data/get    - Request sensor data from ug-data.db
# examples


## [Server <-- Node] Responses
undergrowth/nodes/{nodeId}/responses/{command}
    {nodeId} matches the node's identifier
    {command} reflects the command being responded to (same as above)

## Configuration Settings
undergrowth/server/commands/{nodeId}/config/set/{setting}

#examples given node-123ABC server-456DEF

-----------------------------------INFO GET----------------------------------------
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
  "internetStatus": "Connected"
}
---------------------------------CONFIG GET----------------------------------------
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

----------------------------------CONFIG SET---------------------------------------

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

------------------------------------DATA GET---------------------------------------

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

## Quality of Service (QoS)

MQTT provides three different Quality of Service (QoS) levels that determine the delivery guarantees for messages between clients and brokers:

### QoS Levels

- **QoS 0 (At most once)**
  - Fire and forget - no guarantee of delivery
  - No acknowledgment or storage
  - Fastest and lowest overhead
  - Use for: Non-critical telemetry, high-frequency data where occasional loss is acceptable

- **QoS 1 (At least once)**
  - Guaranteed delivery but with possible duplicates
  - Message stored and acknowledged
  - Messages are resent until acknowledgment
  - Use for: Important messages where handling duplicates is possible

- **QoS 2 (Exactly once)**
  - Guaranteed delivery exactly once
  - Four-part handshake ensures no duplicates
  - Highest overhead and slowest performance
  - Use for: Critical transactions, configuration changes, or when duplicates would cause problems

### QoS Recommendations for Undergrowth System

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

## Configuration Settings
undergrowth/server/commands/{nodeId}/config/set/{setting}

#examples given node-123ABC server-456DEF

-----------------------------------INFO GET----------------------------------------
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
  "internetStatus": "Connected"
}
---------------------------------CONFIG GET----------------------------------------
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

----------------------------------CONFIG SET---------------------------------------

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

------------------------------------DATA GET---------------------------------------

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



Quality of Service:
    Define QoS levels for different message types (e.g., QoS 1 for data requests)
    Specify if any messages should use the "retain" flag

Authentication/Security:
    Add details about authentication requirements
    Specify if TLS/SSL is required

Large Response Handling:
    Define how to handle large datasets (pagination/chunking)
    Maximum message size limitations

Connection Management:
    Add Last Will and Testament (LWT) topic format for node status
    Specify reconnection behavior

Protocol Versioning:
    Add protocol version to messages for future compatibility

Timeouts:
    Define timeout values for responses
    Specify retry behavior

Specific Improvements:
    Add table of all possible config settings for config/set
    Define limits for data/get (max records, sequence range)
    Add wildcards for subscribing to multiple nodes

Implementation Guidelines:
    Add section on message parsing strategies
    Broker configuration recommendations





Database Schema Updates
[ ] Remove legacy sensor tables/columns
[ ] Update sensor_config table to use I2C addresses as unique identifiers
[ ] Add sequence tracking for data synchronization
[ ] Add server sync tracking table
Sensor Management
[ ] Update sensor initialization to use I2C addresses
[ ] Remove legacy sensor handling (sensor1, sensor2)
[ ] Update sensor reading storage to use standardized format
[ ] Add sensor calibration support
MQTT Communication
[ ] Implement "info get" request handling
[ ] Update sensor data publishing format
[ ] Add sequence-based data synchronization
[ ] Implement server sync status tracking
SystemInfo Class Updates
[ ] Add sensor statistics tracking
[ ] Add sync statistics tracking
[ ] Add MQTT status tracking
[ ] Implement info get response formatting
API Updates
[ ] Update sensor endpoints to use new schema
[ ] Add sequence info endpoint
[ ] Add sensor statistics endpoint
[ ] Update binned readings endpoint
UI Updates
[ ] Update sensor display to use new format
[ ] Add sync status display
[ ] Update graph view to handle new data format
[ ] Add sensor statistics display
Testing & Validation
[ ] Test sensor initialization
[ ] Test data storage
[ ] Test MQTT communication
[ ] Test UI updates
[ ] Test data synchronization
Would you like to start with any particular section? I recommend beginning with the database schema updates since that will form the foundation for the other changes.