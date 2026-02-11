#!/bin/bash
# Setup systemd services for Google Ads Auction Scraper
# Run on VPS: bash setup-systemd.sh

set -e

echo "=== Setting up Xvfb + GAds Scraper services ==="

# 1. Xvfb virtual display service
cat > /etc/systemd/system/xvfb.service << 'EOF'
[Unit]
Description=Xvfb Virtual Display :99
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1440x900x24 -ac
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 2. noVNC for remote access
cat > /etc/systemd/system/novnc.service << 'EOF'
[Unit]
Description=noVNC WebSocket Proxy
After=xvfb.service
Requires=xvfb.service

[Service]
Type=simple
ExecStart=/usr/bin/websockify --web /usr/share/novnc 6080 localhost:5900
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 3. x11vnc to connect VNC to Xvfb
cat > /etc/systemd/system/x11vnc.service << 'EOF'
[Unit]
Description=x11vnc VNC Server
After=xvfb.service
Requires=xvfb.service

[Service]
Type=simple
Environment=DISPLAY=:99
ExecStart=/usr/bin/x11vnc -display :99 -forever -nopw -shared -rfbport 5900
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 4. Google Ads Scraper daemon
cat > /etc/systemd/system/gads-scraper.service << 'EOF'
[Unit]
Description=Google Ads Auction Insights Scraper
After=xvfb.service
Requires=xvfb.service

[Service]
Type=simple
WorkingDirectory=/root/gads-scraper
Environment=DISPLAY=:99
ExecStart=/usr/bin/node scraper.js
Restart=on-failure
RestartSec=60
StandardOutput=append:/var/log/gads-scraper.log
StandardError=append:/var/log/gads-scraper.log

[Install]
WantedBy=multi-user.target
EOF

# Enable and start services
systemctl daemon-reload
systemctl enable xvfb x11vnc novnc gads-scraper
systemctl start xvfb
sleep 2
systemctl start x11vnc novnc
echo ""
echo "=== Services installed ==="
echo ""
echo "VNC:     http://$(hostname -I | awk '{print $1}'):6080/vnc.html"
echo "Logs:    journalctl -u gads-scraper -f"
echo "         tail -f /var/log/gads-scraper.log"
echo ""
echo "Next steps:"
echo "  1. Start scraper:  systemctl start gads-scraper"
echo "  2. Login via VNC"
echo "  3. Scraper runs weekly automatically"
echo ""
