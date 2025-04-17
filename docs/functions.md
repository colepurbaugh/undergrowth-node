# Lighting Control Functions

## Core Functions
- `initLighting()`: Initializes lighting control system, EEPROM, PWM, and loads saved state
- `updateLighting()`: Updates lighting output based on current mode and conditions
- `saveSchedulesToEEPROM()`: Saves current state and schedules to EEPROM
- `loadSchedulesFromEEPROM()`: Loads state and schedules from EEPROM
- `setup()`: Main initialization function for the ESP32
- `loop()`: Main program loop handling all periodic tasks

## Time Management
- `timeToSeconds(const char* timeStr)`: Converts time string (HH:MM:SS) to seconds
- `secondsToTime(unsigned long seconds)`: Converts seconds to time string
- `formatMillisToHMS(unsigned long ms)`: Formats milliseconds to HH:MM:SS
- `getCurrentTime()`: Gets current time as formatted string

## Web Interface
- `handleLightingWebRequest(WiFiClient& client, const String& request, const char* version, Adafruit_AHTX0& aht)`: Handles all HTTP requests
- `handleWebSocketMessage(uint8_t num, uint8_t * payload, size_t length)`: Handles WebSocket messages
- `handleWebRequest(WiFiClient& client, const String& request)`: Handles general web requests
- `webSocketEvent(uint8_t num, WStype_t type, uint8_t * payload, size_t length)`: Handles WebSocket events

## MQTT Interface
- `initMQTT()`: Initializes MQTT client and sets up callback
- `mqttLoop()`: Maintains MQTT connection and processes messages
- `mqttCallback(char* topic, byte* payload, unsigned int length)`: Handles incoming MQTT messages
- `publishMQTT(const char* topic, const String &payload)`: Publishes MQTT messages
- `subscribeMQTT(const char* topic)`: Subscribes to MQTT topics

## JSON Generation
- `getLightingStatusJSON()`: Generates JSON with current lighting status
- `getSchedulesJSON()`: Generates JSON with all scheduled events

## Event Management
- `updateEventList(events)`: Updates the displayed event list
- `updateCountdown(index, triggerTime)`: Updates countdown for a specific event
- `updateAllCountdowns()`: Updates countdowns for all events

## State Management
- `toggleLighting()`: Toggles lighting system on/off
- `toggleMode()`: Switches between auto/manual modes
- `toggleEvent(index)`: Toggles specific event on/off
- `setManualIntensity()`: Sets manual intensity level
- `toggleOverTemp()`: Toggles over-temperature state
- `toggleLightSensor()`: Toggles light sensor state

## Settings Management
- `updateGlobalSettings()`: Updates global system settings
- `updateMaxIntensityDisplay()`: Updates max intensity display
- `updateClock()`: Updates time display
- `updateDeviceInfo()`: Updates device information display
- `updateStatus(data)`: Updates UI based on received status data

## Event Operations
- `addEvent()`: Adds new lighting event
- `deleteEvent(index)`: Deletes specific event
- `fetchSchedule()`: Fetches current schedule from server

## Utility Functions
- `handleIntensityKeyPress(event)`: Handles intensity input keypress
- `updateLightSensorError()`: Updates light sensor error display
