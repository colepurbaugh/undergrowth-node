# Undergrowth Node Documentation

## Purpose
This document serves as a comprehensive reference for the Undergrowth Node system. It is created to:
1. Provide accurate technical documentation of the system's components and functionality
2. Serve as a reference for maintenance and future development
3. Document the actual implementation, not assumptions or desired functionality
4. Help new developers understand the system's architecture and behavior

## Documentation Approach
This document will be built by:
1. Examining each file in the system
2. Documenting actual functionality, not assumptions
3. Verifying all information with the system's maintainer
4. Updating as the system evolves

## Project Structure

### Root Directory
```
undergrowth-node/
├── aht10.js              # AHT10 sensor interface
├── docs/                 # Documentation
│   ├── functions.md      # This file
│   └── installation.md   # Installation instructions
├── LICENSE              # License file
├── node_modules/        # Node.js dependencies
├── package.json         # Project configuration
├── package-lock.json    # Dependency lock file
├── public/              # Web interface files
│   ├── assets/          # Static assets
│   │   └── icons/       # Favicon and icons
│   │       ├── android-chrome-192x192.png
│   │       ├── android-chrome-512x512.png
│   │       ├── apple-touch-icon.png
│   │       ├── favicon-16x16.png
│   │       ├── favicon-32x32.png
│   │       ├── favicon.ico
│   │       ├── site.webmanifest
│   │       └── ug-node.db
│   ├── graph.html       # Data visualization interface
│   ├── index.html       # Main dashboard
│   ├── pwm.html         # Manual PWM control interface
│   └── schedule.html    # Event scheduling interface
├── README.md            # Project overview
├── server.js            # Main server application
├── systemInfo.js        # System information module
├── undergrowth.db       # Configuration database
└── undergrowth-data.db  # Data logging database
```

## server.js Analysis

### Node Packages
- express: Web server framework
- socket.io: Real-time communication
- http: HTTP server
- raspi: Raspberry Pi hardware interface
- raspi-i2c: I2C communication
- pigpio: GPIO control
- path: File path utilities
- sqlite3: Database management

### Socket.IO Events

#### Client to Server
- getInitialState: Request initial system state
- pwmSet: Set PWM value for a pin
- pwmToggle: Toggle PWM pin on/off
- toggleEvent: Toggle event on/off
- addEvent: Add new event
- deleteEvent: Delete existing event
- setMode: Set system mode (automatic/manual)
- emergencyStop: Trigger emergency stop
- clearEmergencyStop: Clear emergency stop
- getTimezone: Request current timezone
- setTimezone: Set new timezone
- getEvents: Request current events
- toggleNormalEnable: Toggle normal operation
- toggleMode: Toggle system mode
- disconnect: Client disconnection

#### Server to Client
- initialState: Send initial system state
- pwmStateUpdate: Update PWM states
- safetyStateUpdate: Update safety states
- eventsUpdated: Update event list
- sensorData: Send sensor readings
- timezoneUpdate: Update timezone
- modeError: Mode change error
- modeUpdate: Mode changed
- pwmError: PWM operation error
- eventError: Event operation error
- eventDeleted: Event deleted
- eventToggled: Event toggled
- safetyStateChanged: Safety state changed

### Functions
- initPwmPins: Initialize PWM hardware
- loadPwmStates: Load PWM states from database
- initAndRead: Initialize sensors and start reading
- broadcastSafetyState: Send safety state to clients
- broadcastPWMState: Send PWM states to clients
- emergencyStop: Handle emergency stop
- clearEmergencyStop: Clear emergency stop state
- togglePWM: Toggle PWM pin state
- broadcastEvents: Send events to clients
- isSystemSafe: Check system safety state
- toggleNormalEnable: Toggle normal operation
- controlLoop: Main control loop

### Control Loop Flow
The control loop follows this sequence:

1. **Safety State Check**
   - Queries the `safety_state` table
   - Creates an object mapping safety keys to their values
   - Specifically checks for `emergency_stop` and `normal_enable` states

2. **Mode Check**
   - Queries the `system_state` table for the current mode
   - Defaults to manual mode (1) if no mode is set

3. **Safety Override**
   - If PWM is enabled:
     - Checks for emergency stop or disabled normal operation
     - If either condition is true, immediately turns off all PWM outputs
     - Exits the loop

4. **Automatic Mode (mode = 0)**
   - Calculates current time in seconds (hours * 3600 + minutes * 60 + seconds)
   - Retrieves all enabled events from the `events` table
   - For each GPIO:
     - Finds the most recent past event or next upcoming event
     - Converts event PWM value (0-1023) to hardware value (0-255)
     - Updates the GPIO output
     - Updates the `auto_pwm_states` table
   - Turns off any GPIOs without active events
   - Updates `auto_pwm_states` for inactive GPIOs

5. **Manual Mode (mode = 1)**
   - Retrieves current manual PWM states from `pwm_states` table
   - For each GPIO:
     - If enabled: converts value (0-1023) to hardware value (0-255)
     - If disabled: sets output to 0
     - Updates the GPIO output accordingly

6. **Error Handling**
   - Catches and logs any errors during the process
   - Continues to next iteration regardless of errors

The loop runs continuously, updating hardware outputs based on the current mode, safety states, and either scheduled events (automatic mode) or manual settings (manual mode).

### Database Structure

#### Configuration Database (undergrowth.db)

1. **events**
   - `id`: INTEGER PRIMARY KEY AUTOINCREMENT
   - `gpio`: INTEGER NOT NULL
   - `time`: TEXT NOT NULL
   - `pwm_value`: INTEGER NOT NULL
   - `enabled`: INTEGER DEFAULT 1
   - Purpose: Stores scheduled events for automatic mode

2. **pwm_states**
   - `pin`: INTEGER PRIMARY KEY
   - `value`: INTEGER DEFAULT 0
   - `enabled`: INTEGER DEFAULT 0
   - `last_modified`: DATETIME DEFAULT CURRENT_TIMESTAMP
   - Purpose: Stores manual mode PWM states

3. **auto_pwm_states**
   - `pin`: INTEGER PRIMARY KEY
   - `value`: INTEGER DEFAULT 0
   - `enabled`: INTEGER DEFAULT 0
   - `last_modified`: DATETIME DEFAULT CURRENT_TIMESTAMP
   - Purpose: Stores automatic mode PWM states

4. **safety_state**
   - `key`: TEXT PRIMARY KEY
   - `value`: INTEGER DEFAULT 0
   - Purpose: Stores safety-related states (emergency_stop, normal_enable)

5. **system_state**
   - `key`: TEXT PRIMARY KEY
   - `value`: INTEGER DEFAULT 1
   - Purpose: Stores system configuration (mode)

6. **timezone**
   - `key`: TEXT PRIMARY KEY
   - `value`: TEXT DEFAULT 'America/Los_Angeles'
   - Purpose: Stores system timezone setting

#### Data Logging Database (undergrowth-data.db)

1. **sensor_readings**
   - `id`: INTEGER PRIMARY KEY AUTOINCREMENT
   - `timestamp`: DATETIME DEFAULT CURRENT_TIMESTAMP
   - `device_id`: TEXT
   - `type`: TEXT
   - `value`: REAL
   - Purpose: Stores historical sensor data

[Next: Continue examining server.js functions in detail]
