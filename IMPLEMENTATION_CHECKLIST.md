# Camera Sensor Integration - Implementation Checklist

Follow this checklist step-by-step to integrate a real camera with your Sensor Integration System.

## 📋 Pre-Implementation (Week 1)

### Planning & Architecture
- [ ] Read `CAMERA_INTEGRATION_GUIDE.md` to understand the architecture
- [ ] Decide on implementation strategy:
  - [ ] Strategy 1: Browser Webcam (Easiest, web-only)
  - [ ] Strategy 2: Raspberry Pi/Device (Most production-ready)
  - [ ] Strategy 3: IP Camera (Enterprise)
- [ ] Plan your database schema based on chosen approach
- [ ] Design file storage strategy (database vs disk vs cloud)

### Hardware Setup (if using Strategy 2 or 3)
- [ ] Obtain hardware:
  - [ ] Raspberry Pi (3B+ or later recommended)
  - [ ] USB Camera or Raspberry Pi Camera Module
  - [ ] USB Cable, Power adapter, SD Card
- [ ] Set up Raspberry Pi OS
- [ ] Test camera with standard tools:
  ```bash
  # Test USB camera
  ls /dev/video*
  
  # Test Pi Camera
  libcamera-hello --list-cameras
  ```

---

## 🖥️ Backend Implementation (Week 1-2)

### Database Setup
- [ ] Backup existing database
- [ ] Add image storage columns to sensor_data table:
  ```bash
  sqlite3 sensor_system.db < database_migrations.sql
  ```
- [ ] Verify schema changes:
  ```sql
  PRAGMA table_info(sensor_data);
  ```
- [ ] Optional: Create dedicated camera_frames table (see migrations file)
- [ ] Set up file upload directory with proper permissions:
  ```bash
  mkdir -p public/uploads
  chmod 755 public/uploads
  ```

### Server Endpoint Implementation
- [ ] Copy code from `server_sensor_endpoint.js`
- [ ] Add image serving middleware at top of server.js (after other middleware):
  ```javascript
  const path = require('path');
  app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
  ```
- [ ] Add all three endpoints to server.js:
  - [ ] `POST /api/sensor-data/submit` - Receives image data
  - [ ] `GET /api/sensor-data/:deviceId/latest-image` - Gets latest image
  - [ ] `GET /api/sensor-data/:deviceId/image-history` - Gets thumbnail gallery
- [ ] Test endpoints with Postman or curl:
  ```bash
  curl -H "Authorization: Bearer YOUR_TOKEN" \
       http://localhost:3001/api/sensor-data/camera_001/latest-image
  ```
- [ ] Verify images are being saved to `public/uploads/device_*/`
- [ ] Test image retrieval by visiting endpoint URL in browser

### Environment Variables (Optional)
- [ ] Add to `.env` if needed:
  ```
  MAX_IMAGE_SIZE=2097152    # 2MB
  UPLOAD_DIR=public/uploads
  IMAGE_RETENTION_DAYS=30
  ```

---

## 🎨 Frontend Implementation (Week 2)

### Quick Test (Browser Webcam)
- [ ] Copy `public/camera_capture.html` to your public folder
- [ ] Open in browser: `http://localhost:3001/camera_capture.html`
- [ ] Get JWT token from localStorage:
  ```javascript
  localStorage.getItem('token')
  ```
- [ ] Test camera capture interface:
  - [ ] Initialize Camera
  - [ ] Capture Frame
  - [ ] Verify image uploads to server
  - [ ] Check images appear in `public/uploads/` directory

### Dashboard Integration
- [ ] Copy camera widget code from `CAMERA_WIDGET_COMPONENT.js`
- [ ] Locate device card rendering in index.html React component
- [ ] Add CameraWidget component after sensor readings section:
  ```jsx
  <CameraWidget 
    device={device} 
    token={authToken} 
    apiUrl="/api" 
  />
  ```
- [ ] Test dashboard:
  - [ ] Device card displays camera widget (not visible for non-camera devices)
  - [ ] Latest image loads within 5 seconds
  - [ ] "Refresh" button updates image
  - [ ] "Show History" displays thumbnail gallery
  - [ ] Click thumbnail updates main display

### UI Enhancements (Optional)
- [ ] Add camera icon to device type selector
- [ ] Implement image zoom/fullscreen modal
- [ ] Add timestamp overlay on images
- [ ] Show motion detection metadata
- [ ] Create timelapse controls

---

## 📱 Client Implementation - Browser Method (Week 1)

### Setup
- [ ] No additional software needed
- [ ] Works on Windows, Mac, Linux
- [ ] Requires modern browser with WebRTC support

### Testing
- [ ] [ ] Create test device with Device ID: `camera_001`
- [ ] Open `http://localhost:3001/camera_capture.html`
- [ ] Paste configuration:
  - Server URL: `http://localhost:3001`
  - JWT Token: (from localStorage)
  - Device ID: `camera_001`
  - Capture Interval: `10`
- [ ] Click "Initialize Camera" → Allow camera access
- [ ] Click "Start Auto Capture"
- [ ] Verify:
  - [ ] Frame count increases every 10 seconds
  - [ ] Upload count increases (frames uploaded successfully)
  - [ ] Connection status shows "Connected" (green)
  - [ ] Images appear in dashboard

### Troubleshooting Browser Method
- [ ] If "camera permission denied": 
  - Use HTTPS or localhost
  - Check browser camera permissions settings
  - Try incognito mode
- [ ] If uploads fail with 403:
  - Verify JWT token is correct and not expired
  - Check device_id matches registered device
  - Verify User ID matches device owner
- [ ] If no frames appear:
  - Check console for JavaScript errors (F12)
  - Verify server endpoint is responding
  - Check `public/uploads/` directory for files

---

## 🍓 Raspberry Pi Implementation (Week 2-3)

### Prerequisites
- [ ] Raspberry Pi running latest Raspberry Pi OS
- [ ] USB Camera or Pi Camera connected and tested
- [ ] Python 3.7+ installed
- [ ] Internet connection to server

### Installation

#### Step 1: Create Directory
```bash
- [ ] mkdir -p /opt/camera_sensor
- [ ] cd /opt/camera_sensor
```

#### Step 2: Copy Scripts
- [ ] Copy `camera_device_capture.py` to `/opt/camera_sensor/`
- [ ] Copy `camera_sensor.service` to `/opt/camera_sensor/`
- [ ] Set permissions:
  ```bash
  sudo chmod 755 /opt/camera_sensor/camera_device_capture.py
  sudo chmod 755 /opt/camera_sensor/camera_sensor.service
  ```

#### Step 3: Install Dependencies
```bash
- [ ] sudo apt-get update
- [ ] sudo apt-get install -y python3-pip python3-opencv
- [ ] pip3 install requests
```

#### Step 4: Configure Script
- [ ] Edit `/opt/camera_sensor/camera_device_capture.py`
- [ ] Update CONFIG section:
  ```python
  'SERVER_URL': 'http://YOUR_SERVER_IP:3001',
  'DEVICE_ID': 'camera_pi_001',
  'JWT_TOKEN': 'YOUR_TOKEN_HERE',
  'CAMERA_INDEX': 0,  # Adjust if needed
  'CAPTURE_INTERVAL': 10,
  ```
- [ ] Save file

#### Step 5: Test Script Manually
```bash
- [ ] cd /opt/camera_sensor
- [ ] python3 camera_device_capture.py
```
Expected output:
```
[timestamp] - INFO - Starting camera capture service...
[timestamp] - INFO - Camera initialized successfully
[timestamp] - INFO - Resolution: 1280x720
[timestamp] - INFO - FPS: 15
[timestamp] - INFO - Frame uploaded successfully (ID: 12345, size: 98765 bytes)
```

- [ ] Stop with Ctrl+C
- [ ] Verify images in `public/uploads/device_camera_pi_001/` on server

#### Step 6: Install as System Service
```bash
- [ ] sudo cp /opt/camera_sensor/camera_sensor.service /etc/systemd/system/
- [ ] sudo systemctl daemon-reload
- [ ] sudo systemctl enable camera_sensor
- [ ] sudo systemctl start camera_sensor
```

#### Step 7: Verify Service Running
```bash
- [ ] sudo systemctl status camera_sensor
- [ ] sudo journalctl -u camera_sensor -f  # Watch live logs
- [ ] sudo systemctl restart camera_sensor  # Test restart
```

### Raspberry Pi Troubleshooting

#### Camera Not Detected
- [ ] Check USB camera: `ls /dev/video*`
- [ ] Try camera_index: 1, 2, etc in CONFIG
- [ ] Run: `v4l2-ctl --list-devices`

#### Connection Fails
- [ ] Verify server is running: `curl http://SERVER_IP:3001/`
- [ ] Check network: `ping SERVER_IP`
- [ ] Verify device exists on server: `curl -H "Authorization: Bearer TOKEN" http://SERVER_IP:3001/api/devices`

#### Permission Errors
```bash
- [ ] Check file permissions: ls -la /opt/camera_sensor/
- [ ] Fix if needed: sudo chown -R pi:pi /opt/camera_sensor/
```

#### High CPU Usage
- [ ] Reduce QUALITY (70 → 60)
- [ ] Reduce FRAME_WIDTH/HEIGHT (1280 → 640)
- [ ] Enable MOTION_DETECTION to skip frames
- [ ] Increase CAPTURE_INTERVAL (10 → 30 seconds)

#### Logs Show Upload Timeout
- [ ] Check server logs: Check if images are being received
- [ ] Verify network bandwidth available
- [ ] Reduce image quality
- [ ] Check for network issues on Pi: ping -c 10 8.8.8.8

---

## 📊 Testing & Validation

### Test Scenarios

#### Scenario 1: Single Camera Upload
- [ ] Create device with Device Type = "Camera"
- [ ] Use browser capture to upload one frame
- [ ] Verify image in database:
  ```sql
  SELECT * FROM sensor_data WHERE device_id='camera_001' ORDER BY timestamp DESC LIMIT 5;
  ```
- [ ] Verify file on disk: `ls -lah public/uploads/device_camera_001/`
- [ ] View image in browser via `/uploads/device_camera_001/TIMESTAMP.jpg`
- [ ] Display on dashboard without errors

#### Scenario 2: Auto-Capture 10 Frames
- [ ] Set capture interval to 5 seconds
- [ ] Run auto-capture for 1 minute
- [ ] Verify 10+ frames captured:
  ```sql
  SELECT COUNT(*) as frame_count FROM sensor_data WHERE device_id='camera_001';
  ```
- [ ] Verify upload count = capture count
- [ ] Check disk space usage: `du -sh public/uploads/`

#### Scenario 3: Motion Detection
- [ ] Enable MOTION_DETECTION in Python script
- [ ] Set MOTION_THRESHOLD = 3000
- [ ] Run script for 2 minutes
- [ ] Move in front of camera for 30 seconds (trigger motion)
- [ ] Verify:
  - [ ] More frames when motion detected
  - [ ] Fewer frames when stationary
  - [ ] motion_detected field in metadata

#### Scenario 4: Multiple Devices
- [ ] Create 3 camera devices
- [ ] Add different GPIO pins or USB indexes
- [ ] Run capture on all 3 simultaneously
- [ ] Verify each device has own upload directory
- [ ] Test dashboard displays all cameras correctly

#### Scenario 5: Performance Under Load
- [ ] Set capture interval to 2 seconds (rapid uploads)
- [ ] Run for 10 minutes
- [ ] Monitor:
  - [ ] Server CPU usage (should stay < 50%)
  - [ ] Disk space (public/uploads/)
  - [ ] Database size
  - [ ] Upload success rate (should be > 95%)

### Automated Tests

Create test file `test_camera_integration.js`:
```javascript
const TEST_TOKEN = 'your_jwt_token';
const SERVER_URL = 'http://localhost:3001';
const DEVICE_ID = 'camera_001';

async function testCameraIntegration() {
  console.log('Testing camera integration...\n');

  try {
    // Test 1: Get device
    console.log('Test 1: Verify device exists');
    let res = await fetch(`${SERVER_URL}/api/devices`, {
      headers: { 'Authorization': `Bearer ${TEST_TOKEN}` }
    });
    let devices = await res.json();
    const device = devices.find(d => d.device_id === DEVICE_ID);
    console.log(device ? '✓ Device found' : '✗ Device not found\n');

    // Test 2: Get latest image
    console.log('\nTest 2: Get latest image');
    res = await fetch(
      `${SERVER_URL}/api/sensor-data/${DEVICE_ID}/latest-image`,
      { headers: { 'Authorization': `Bearer ${TEST_TOKEN}` } }
    );
    if (res.ok) {
      const img = await res.json();
      console.log('✓ Latest image retrieved:', img.image_url);
    } else {
      console.log('✗ Failed to get image:', res.status);
    }

    // Test 3: Get image history
    console.log('\nTest 3: Get image history');
    res = await fetch(
      `${SERVER_URL}/api/sensor-data/${DEVICE_ID}/image-history?limit=5`,
      { headers: { 'Authorization': `Bearer ${TEST_TOKEN}` } }
    );
    if (res.ok) {
      const data = await res.json();
      console.log(`✓ Retrieved ${data.images.length} history images`);
    }

    console.log('\n✓ All tests passed!');
  } catch (err) {
    console.error('✗ Test failed:', err.message);
  }
}

testCameraIntegration();
```

---

## 🔒 Security Checklist

- [ ] **Authentication**
  - [ ] All endpoints require valid JWT token
  - [ ] Device access limited to device owner
  - [ ] Token expiration enforced

- [ ] **Image Validation**
  - [ ] Maximum file size enforced (2MB)
  - [ ] File type validation (JPEG only)
  - [ ] Malicious payload detection

- [ ] **File Permissions**
  - [ ] Upload directory not executable
  - [ ] Proper Linux permissions (755 for dirs, 644 for files)
  - [ ] Images not accessible outside `/uploads/`

- [ ] **Rate Limiting**
  - [ ] Rate limit on submit endpoint (max 1 request/second per device)
  - [ ] Implement in server: `express-rate-limit` middleware

- [ ] **Data Privacy**
  - [ ] Implement retention policy (delete images > 30 days)
  - [ ] Consider encryption for sensitive camera feeds
  - [ ] HTTPS enforced in production

---

## 📈 Production Deployment

### Pre-Deployment Checklist
- [ ] All tests passing
- [ ] Database backups created
- [ ] SSL/HTTPS configured
- [ ] Rate limiting enabled
- [ ] Logging configured
- [ ] Monitoring alerts set up
- [ ] Disaster recovery plan documented

### Post-Deployment Checklist
- [ ] Verify cameras online on new servers
- [ ] Test failover/backup systems
- [ ] Monitor resource usage (CPU, memory, disk)
- [ ] Set up log aggregation
- [ ] Document camera configuration for team
- [ ] Schedule maintenance windows
- [ ] Plan scaling strategy if more cameras needed

---

## 📚 Maintenance & Operations

### Daily
- [ ] Check camera devices online status
- [ ] Monitor server logs for errors
- [ ] Verify recent images are being uploaded

### Weekly
- [ ] Check disk usage: `du -sh public/uploads/`
- [ ] Review error logs
- [ ] Test manual image retrieval
- [ ] Verify database size growth is normal

### Monthly
- [ ] Run cleanup of old images (>30 days)
- [ ] Backup database
- [ ] Review performance metrics
- [ ] Update dependencies if needed:
  ```bash
  pip3 install --upgrade requests opencv-python
  ```

### Quarterly
- [ ] Security audit
- [ ] Capacity planning
- [ ] Documentation review
- [ ] Team training

---

## 📞 Support & Troubleshooting

### Common Issues Summary

| Issue | Cause | Solution |
|-------|-------|----------|
| 403 Unauthorized | Invalid/expired token | Re-login, get new token |
| No image appears | Device doesn't exist | Create device with correct ID |
| Upload fails | Network issue | Check connectivity, retry logic |
| High disk usage | No cleanup policy | Implement image retention, auto-delete |
| Slow performance | Large images | Reduce quality setting |
| Camera permission denied | Browser security | Use HTTPS or localhost |

### Debug Mode
```bash
# Enable debug logging on Raspberry Pi
Edit CONFIG in camera_device_capture.py:
CONFIG['LOG_LEVEL'] = 'DEBUG'

# View detailed logs
sudo journalctl -u camera_sensor -f --lines=50 | grep DEBUG
```

### Escalation Path
1. Check logs
2. Verify configuration
3. Test connectivity
4. Review recent changes
5. Contact support with logs

---

## ✅ Final Validation Checklist

Before declaring integration complete:

- [ ] ✓ One camera successfully uploading images
- [ ] ✓ Images display on dashboard with correct timestamps
- [ ] ✓ Image history gallery works (show/hide, zoom)
- [ ] ✓ New device can be added and configured
- [ ] ✓ Existing sensor data (temperature, humidity) still works
- [ ] ✓ No JavaScript errors in browser console
- [ ] ✓ Server logs show no errors
- [ ] ✓ Database contains image_url values
- [ ] ✓ Images accessible via `/uploads/` URL
- [ ] ✓ Auto-refresh works (images update every 30 seconds)
- [ ] ✓ Mobile dashboard responsive with camera widget
- [ ] ✓ Performance acceptable (< 2s image load time)

---

## 🎉 You're Done!

Congratulations! You've successfully integrated camera sensors into your Sensor Integration System.

### Next Steps
1. Deploy to additional cameras
2. Implement motion detection alerts
3. Create image analytics (motion detection, object recognition)
4. Build image viewer with timeline playback
5. Integrate video recording for continuous observation

---

**Last Updated:** 2024-04-15  
**Version:** 1.0  
**Questions?** See `CAMERA_INTEGRATION_GUIDE.md` or `QUICK_START.md`
