#!/bin/bash
# Automation_Custom_Script.sh for undergrowth-node
# This script runs after first boot and performs all custom installation tasks

# Log to dietpi-automation_custom_script.log
exec &> >(tee -a /var/tmp/dietpi/logs/dietpi-automation_custom_script.log)

echo "Starting undergrowth-node installation..."

# Install required packages first
echo "Installing required system packages..."
apt-get update
apt-get install -y git build-essential unzip wget i2c-tools htop python3-distutils python3-dev sqlite3 || echo "Failed to install required packages"

# Get MAC address and set hostname
echo "Setting hostname based on MAC address..."
# Get MAC address of wireless adapter (wlan0)
MAC_ADDR=$(cat /sys/class/net/wlan0/address | tr -d ':' | tr '[a-z]' '[A-Z]')
if [ -n "$MAC_ADDR" ]; then
    # Extract the last 6 characters (3 bytes)
    LAST_SIX=${MAC_ADDR: -6}
    # Set the new hostname
    NEW_HOSTNAME="node-$LAST_SIX"
    echo "Setting hostname to $NEW_HOSTNAME based on MAC address $MAC_ADDR"
    
    # Update hostname in all required locations
    echo "$NEW_HOSTNAME" > /etc/hostname
    sed -i "s/127.0.1.1.*/127.0.1.1\t$NEW_HOSTNAME/" /etc/hosts
    hostname "$NEW_HOSTNAME"
    
    # If using DietPi, also update the DietPi config
    if [ -f "/boot/dietpi.txt" ]; then
        sed -i "s/^AUTO_SETUP_NET_HOSTNAME=.*/AUTO_SETUP_NET_HOSTNAME=$NEW_HOSTNAME/" /boot/dietpi.txt
    fi
else
    echo "Could not get MAC address. Hostname not changed."
fi

# Enable I2C interface
echo "Enabling I2C interface..."
/boot/dietpi/func/dietpi-set_hardware i2c enable || echo "Failed to enable I2C interface"

# Enable GPIO in config.txt if not already enabled
echo "Enabling GPIO in config.txt..."
if ! grep -q "^dtparam=gpio=on" /boot/config.txt; then
    echo "dtparam=gpio=on" >> /boot/config.txt
    echo "Added GPIO configuration to config.txt"
else
    echo "GPIO already enabled in config.txt"
fi

# Enable SPI in config.txt if not already enabled
echo "Enabling SPI in config.txt..."
if ! grep -q "^dtparam=spi=on" /boot/config.txt; then
    echo "dtparam=spi=on" >> /boot/config.txt
    echo "Added SPI configuration to config.txt"
else
    echo "SPI already enabled in config.txt"
fi

# Install Pigpio C Library
echo "Installing Pigpio C Library..."
cd /tmp
wget https://github.com/joan2937/pigpio/archive/master.zip || { echo "Failed to download pigpio"; exit 1; }
unzip master.zip || { echo "Failed to extract pigpio"; exit 1; }
cd pigpio-master || { echo "Failed to change directory"; exit 1; }

# Modify the Makefile to skip Python installation if needed
# This is optional, but helps if Python setup continues to cause issues
sed -i 's/^PYINSTALL.*/PYINSTALL = :/' Makefile || echo "Failed to modify Makefile"

make || { echo "Failed to compile pigpio"; exit 1; }
make install || { echo "Failed to install pigpio"; exit 1; }

# Manually copy libraries and executables if make install fails
if [ ! -f "/usr/local/bin/pigpiod" ]; then
    echo "Manual installation of pigpio..."
    cp libpigpio.so* /usr/local/lib/ || echo "Failed to copy libpigpio.so"
    cp pigpiod /usr/local/bin/ || echo "Failed to copy pigpiod"
    cp pigs /usr/local/bin/ || echo "Failed to copy pigs"
    ldconfig || echo "Failed to run ldconfig"
fi

# Create socket directory for pigpio
echo "Creating socket directory for pigpio..."
mkdir -p /var/run/pigpio

# Start pigpio daemon with updated service definition
systemctl stop pigpiod 2>/dev/null || echo "No pigpiod service to stop"
echo "Creating pigpiod service..."
cat > /etc/systemd/system/pigpiod.service << EOL
[Unit]
Description=Pigpio daemon
After=network.target

[Service]
Type=forking
ExecStart=/usr/local/bin/pigpiod -l
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOL
systemctl daemon-reload
systemctl enable pigpiod || echo "Failed to enable pigpiod service"
systemctl start pigpiod || echo "Failed to start pigpiod service"

# Test pigpio socket connection
echo "Testing pigpio socket connection..."
sleep 2
pigs r 0
if [ $? -eq 0 ]; then
    echo "Pigpio is working correctly!"
else
    echo "Pigpio socket connection failed. Will retry after completing setup."
fi

# Install sqlite3 for database management
echo "Installing sqlite3..."
apt-get install -y sqlite3 || echo "Failed to install sqlite3"

# Install NVM
echo "Installing NVM..."
export NVM_DIR="/home/dietpi/.nvm"
mkdir -p "$NVM_DIR"
chown -R dietpi:dietpi "$NVM_DIR"
su - dietpi -c "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.5/install.sh | bash" || { echo "Failed to install NVM"; exit 1; }
# Source NVM for this session
export NVM_DIR="/home/dietpi/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"  # This loads nvm

# Install Node.js
echo "Installing Node.js..."
su - dietpi -c "cd && export NVM_DIR=\"/home/dietpi/.nvm\" && [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\" && nvm install --lts && nvm use --lts && NODE_VERSION=\$(nvm current) && nvm alias default \"\$NODE_VERSION\"" || { echo "Failed to install Node.js"; exit 1; }

# Add NVM to dietpi profile
echo 'export NVM_DIR="/home/dietpi/.nvm"' >> /home/dietpi/.bashrc
echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm' >> /home/dietpi/.bashrc
echo '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion' >> /home/dietpi/.bashrc

# Clone the repository
echo "Cloning undergrowth-node repository..."
mkdir -p /home/dietpi/git
chown dietpi:dietpi /home/dietpi/git
su - dietpi -c "cd /home/dietpi/git && git clone https://github.com/colepurbaugh/undergrowth-node.git" || { echo "Failed to clone repository"; exit 1; }
cd /home/dietpi/git/undergrowth-node || { echo "Failed to change directory"; exit 1; }

# Create database directory if it doesn't exist (before creating willa user)
echo "Creating database directory..."
su - dietpi -c "mkdir -p /home/dietpi/git/undergrowth-node/database"

# Create willa user for read-only database access
echo "Creating willa user for database access..."
if ! id "willa" &>/dev/null; then
    useradd -m -s /bin/bash willa || { echo "Failed to create willa user"; exit 1; }
    echo "willa:12grow34" | chpasswd || { echo "Failed to set willa password"; exit 1; }
    echo "Created willa user with password 12grow34"
else
    echo "willa user already exists"
    echo "willa:12grow34" | chpasswd || { echo "Failed to update willa password"; exit 1; }
fi

# Create willa's git directory structure to match dietpi's
echo "Setting up willa's directory structure..."
su - willa -c "mkdir -p /home/willa/git/undergrowth-node"

# Create symbolic link from willa's database directory to dietpi's database directory
echo "Creating symbolic link for database access..."
su - willa -c "ln -sf /home/dietpi/git/undergrowth-node/database /home/willa/git/undergrowth-node/database" || echo "Failed to create symbolic link"

# Set proper permissions for database directory
echo "Setting database directory permissions..."
chown -R dietpi:dietpi /home/dietpi/git/undergrowth-node/database
chmod -R 755 /home/dietpi/git/undergrowth-node/database

# Add willa to dietpi group for read access
usermod -a -G dietpi willa || echo "Failed to add willa to dietpi group"

# Install npm dependencies
echo "Installing npm dependencies..."
su - dietpi -c "cd /home/dietpi/git/undergrowth-node && export NVM_DIR=\"/home/dietpi/.nvm\" && [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\" && npm install && npm install pigpio" || { echo "Failed to install npm dependencies"; exit 1; }

# Make sure node can be accessed by root 
chmod -R g+rx /home/dietpi/.nvm

# Get actual Node.js path - double check to make sure it exists
echo "Determining Node.js path..."
NODE_PATH=$(su - dietpi -c "export NVM_DIR=\"/home/dietpi/.nvm\" && [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\" && which node")
if [ ! -f "$NODE_PATH" ]; then
    echo "Node.js executable not found via 'which'. Using direct path."
    NODE_PATH="/home/dietpi/.nvm/versions/node/$(ls -t /home/dietpi/.nvm/versions/node/ 2>/dev/null | head -1)/bin/node"
    if [ ! -f "$NODE_PATH" ]; then
        echo "ERROR: Cannot find Node.js executable. Service creation will fail!"
    fi
fi
echo "Using Node.js at: $NODE_PATH"

# Setup systemd service
echo "Setting up systemd service..."
# Make sure node path exists and is executable
if [ -f "$NODE_PATH" ] && [ -x "$NODE_PATH" ]; then
    cat > /etc/systemd/system/ug-node.service << EOL
[Unit]
Description=Undergrowth Node.js Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/dietpi/git/undergrowth-node
ExecStart=${NODE_PATH} ug-node.js
Environment=NODE_ENV=production
Environment=PATH=/home/dietpi/.nvm/versions/node/$(ls -t /home/dietpi/.nvm/versions/node/ 2>/dev/null | head -1)/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PIGPIO_ADDR=localhost
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=ug-node

[Install]
WantedBy=multi-user.target
EOL

    # Verify service file was created
    if [ -f "/etc/systemd/system/ug-node.service" ]; then
        echo "Service file created successfully."
    else
        echo "ERROR: Failed to create service file!"
    fi
else
    echo "ERROR: Node.js path is invalid. Cannot create service."
fi

# Make node.js able to bind to port 80
echo "Setting capabilities for Node.js..."
if [ -f "$NODE_PATH" ]; then
    setcap 'cap_net_bind_service=+ep' "$NODE_PATH" || echo "Failed to set capabilities"
else
    echo "ERROR: Cannot set capabilities, Node.js path not found."
fi

# Add user to necessary groups
echo "Adding user to required groups..."
usermod -a -G gpio,i2c,spi,kmem dietpi || echo "Failed to add user to groups"

# Enable and start the service
echo "Enabling and starting ug-node service..."
if [ -f "/etc/systemd/system/ug-node.service" ]; then
    systemctl daemon-reload
    systemctl enable ug-node || echo "Failed to enable service"
    systemctl start ug-node || echo "Failed to start service"
    
    # Check if service started successfully
    systemctl status ug-node
    if systemctl is-active --quiet ug-node; then
        echo "ug-node service is running."
    else
        echo "WARNING: ug-node service is not running!"
    fi
else
    echo "ERROR: Cannot enable/start service, service file not found."
fi

# Final pigpio test to verify it's working
echo "Final pigpio test..."
pigs r 0
if [ $? -eq 0 ]; then
    echo "Pigpio is working correctly!"
else
    echo "Pigpio not working, attempting to fix..."
    # Stop pigpiod and clean up
    systemctl stop pigpiod
    sleep 2
    # Remove any stale lock files
    rm -f /var/run/pigpio.pid
    rm -f /tmp/pigpio*
    sleep 1
    # Restart pigpiod
    systemctl start pigpiod
    sleep 3
    # Test again
    pigs r 0
    if [ $? -eq 0 ]; then
        echo "Pigpio fixed and working correctly!"
    else
        echo "Pigpio still not working, manual troubleshooting may be needed."
        echo "Try running: systemctl restart pigpiod"
        echo "Then test with: pigs r 0"
    fi
fi

# Test willa user database access
echo "Testing willa user database access..."
if su - willa -c "ls -la /home/willa/git/undergrowth-node/database" >/dev/null 2>&1; then
    echo "Willa user can access database directory successfully"
    # Test if willa can read the directory (for rsync)
    if su - willa -c "cd /home/willa/git/undergrowth-node && pwd" >/dev/null 2>&1; then
        echo "Willa user directory structure is correct"
    else
        echo "WARNING: Willa user directory structure may have issues"
    fi
else
    echo "WARNING: Willa user cannot access database directory"
fi

echo "Undergrowth node installation completed!" 