# TàbDey Backend Services

Backend services for the **TàbDey Super App** platform.

This backend handles customer, merchant, admin, order, pickup, delivery, chat, notification, upload, email, and receipt-related operations for the TàbDey application.

---

## 1. Project Overview

TàbDey Backend Services is a Node.js backend system built for a multi-role super app platform.

It supports:

* Customer mobile app
* Merchant mobile app
* Admin dashboard
* Business and merchant management
* Item and category management
* Order placement and order tracking
* Pickup and delivery workflows
* Scheduled orders
* Merchant-user chat
* Push notifications
* Image and document uploads
* PDF receipt generation
* Email receipt sending

---

## 2. Tech Stack

| Component          | Technology                 |
| ------------------ | -------------------------- |
| Runtime            | Node.js                    |
| Framework          | Express.js                 |
| Database           | MySQL                      |
| Email Service      | Nodemailer / SMTP          |
| File Upload        | Multer                     |
| PDF Receipt        | Custom PDF Receipt Service |
| Authentication     | JWT                        |
| Notification       | Expo Push Notification API |
| Deployment         | Docker / Kubernetes        |
| Environment Config | `.env`, ConfigMap, Secret  |

---

## 3. Main Features

### Customer Features

* Register and log in
* Browse businesses and items
* Place orders
* Select pickup or delivery
* Track order status
* Chat with merchant
* Receive push notifications
* Receive email receipts

### Merchant Features

* Merchant login
* Manage business profile
* Manage items and categories
* Accept or decline orders
* Accept scheduled orders with estimated preparation time
* Update order status
* Chat with customers
* Receive order notifications
* View grouped customer orders

### Admin Features

* Manage users
* Manage merchants
* Manage businesses
* Manage documents
* Manage banners and promotions
* Upload logos and images
* Monitor platform data

### Order Features

* Normal order
* Scheduled order
* Pickup order
* Delivery order
* Order status update
* Item replacement
* PDF receipt generation
* Email receipt sending
* Customer and merchant notifications

---

## 4. Project Structure

```txt
backend/
│
├── app.js
├── server.js
├── package.json
├── .env
│
├── config/
│   └── db.js
│
├── controllers/
│   ├── authController.js
│   ├── orderController.js
│   ├── businessController.js
│   ├── itemController.js
│   ├── chatController.js
│   └── notificationController.js
│
├── models/
│   ├── orderModels.js
│   ├── userModel.js
│   ├── businessModel.js
│   └── ...
│
├── routes/
│   ├── authRoutes.js
│   ├── orderRoutes.js
│   ├── businessRoutes.js
│   ├── itemRoutes.js
│   ├── chatRoutes.js
│   └── notificationRoutes.js
│
├── services/
│   ├── pdfReceiptService.js
│   ├── pickupEmailService.js
│   ├── emailService.js
│   ├── notificationService.js
│   └── ...
│
├── middleware/
│   ├── authMiddleware.js
│   ├── upload.js
│   └── errorHandler.js
│
├── uploads/
│   ├── chat/
│   ├── logo_and_image/
│   ├── items/
│   └── documents/
│
└── k8s/
    ├── deployment.yaml
    ├── service.yaml
    ├── configmap.yaml
    └── secret.yaml
```

---

## 5. Installation

Clone the repository:

```bash
git clone <repository-url>
cd backend
```

Install dependencies:

```bash
npm install
```

Create an environment file:

```bash
touch .env
```

Add the required environment variables inside `.env`.

---

## 6. Environment Variables

Example `.env` file:

```env
# App
NODE_ENV=development
PORT=3000

# Backend URL
BASE_URL=https://backend.tabdhey.bt
MEDIA_BASE_URL=https://backend.tabdhey.bt

# Database
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=Superapp_production
DB_PORT=3306

# JWT
JWT_SECRET=your_jwt_secret
JWT_EXPIRES_IN=7d

# SMTP / Email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password
SMTP_FROM="TàbDey" <your_email@gmail.com>

# Alternative Email Variables
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_app_password

# Uploads
UPLOAD_ROOT=uploads
UPLOAD_DIR=uploads/chat
MAX_IMAGE_BYTES=8388608

# Expo Push Notification
EXPO_NOTIFICATION_URL=https://backend.tabdhey.bt/expo/api/push/send

# Redis, if used
REDIS_URL=redis://localhost:6379
```

Important:

* Do not commit `.env` to Git.
* Use Gmail app password for SMTP.
* Store production secrets in Kubernetes Secret or server environment variables.
* `MEDIA_BASE_URL` must point to the public backend URL so uploaded files can be accessed from the app.

---

## 7. Run the Server

Development:

```bash
npm run dev
```

or:

```bash
node server.js
```

Production:

```bash
npm start
```

Default local server:

```txt
http://localhost:3000
```

---

## 8. API Base URL

Production backend URL:

```txt
https://backend.tabdhey.bt
```

Admin base URL:

```txt
https://backend.tabdhey.bt/admin
```

Example:

```txt
https://backend.tabdhey.bt/admin/api/businesses
```

---

## 9. Authentication

Protected APIs use JWT authentication.

Send the token in the request header:

```http
Authorization: Bearer <access_token>
```

Some merchant and chat APIs may also require custom headers:

```http
x-user-id: <user_id>
x-business-id: <business_id>
x-user-type: MERCHANT
```

Example:

```http
GET /chat/chat/messages/119?limit=80
Authorization: Bearer <token>
x-user-id: 58
x-business-id: 19
x-user-type: MERCHANT
```

---

## 10. Common API Modules

### Auth APIs

```txt
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/profile
```

### User APIs

```txt
GET    /api/users
GET    /api/users/:id
PUT    /api/users/:id
DELETE /api/users/:id
```

### Business APIs

```txt
GET    /admin/api/businesses
GET    /admin/api/businesses/:id
POST   /admin/api/businesses
PUT    /admin/api/businesses/:id
DELETE /admin/api/businesses/:id
```

### Item APIs

```txt
GET    /api/items
GET    /api/items/:id
POST   /api/items
PUT    /api/items/:id
DELETE /api/items/:id
```

### Order APIs

```txt
POST /api/orders
GET  /api/orders
GET  /api/orders/:order_id
PUT  /api/orders/:order_id/status
GET  /api/orders/business/:business_id
```

### Chat APIs

```txt
POST /chat/chat/conversation
GET  /chat/chat/messages/:conversation_id
POST /chat/chat/messages
```

### Notification APIs

```txt
GET  /api/notifications
POST /api/notifications/read
POST /expo/api/push/send
```

Note: Route names may differ depending on the actual route files. Always confirm final route names from the `routes/` directory.

---

## 11. File Uploads

The backend supports file and image uploads using Multer.

Common upload folders:

```txt
uploads/
├── chat/
├── logo_and_image/
├── items/
├── documents/
└── banners/
```

Example uploaded file URL:

```txt
https://backend.tabdhey.bt/admin/uploads/logo_and_image/example.webp
```

### Git Ignore for Uploads

Uploads should normally be ignored in Git:

```gitignore
uploads/
admin/uploads/
```

If empty folders must be preserved, add `.gitkeep` files:

```txt
uploads/.gitkeep
admin/uploads/.gitkeep
```

---

## 12. Email Receipt Service

The backend sends customer email receipts using Nodemailer.

Example service file:

```txt
services/pickupEmailService.js
```

The pickup email service:

* Receives pickup order data
* Converts pickup data into PDF-compatible format
* Generates a PDF receipt
* Sends an email to the customer
* Attaches the receipt as a PDF file

For pickup orders:

* `delivery_fee` is set to `0`
* `merchant_delivery_fee` is set to `0`
* `platform_fee` uses the actual platform fee
* `pickup_address` is converted into plain address text before sending

Example pickup address:

```json
{
  "address": "Thimphu, Near Clock Tower",
  "lat": 27.472,
  "lng": 89.639
}
```

Email/PDF output:

```txt
Thimphu, Near Clock Tower
```

---

## 13. PDF Receipt Service

PDF receipts are generated using:

```txt
services/pdfReceiptService.js
```

Expected order fields:

```js
{
  order_id,
  customer_name,
  customer_email,
  customer_phone,
  business_name,
  business_logo,
  business_address,
  payment_method,
  status,
  items,
  subtotal,
  grand_total,
  delivery_address,
  delivered_at,
  delivery_fee,
  platform_fee,
  merchant_delivery_fee,
  discount_amount
}
```

---

## 14. Scheduled Orders

Scheduled orders allow merchants to accept an order with estimated preparation time.

Example request body:

```json
{
  "status": "ACCEPTED",
  "estimated_minutes": 30
}
```

Backend should validate:

* Order exists
* Merchant is authorized
* Status transition is allowed
* Estimated minutes is provided when required

---

## 15. Chat Service

The chat service supports user-to-merchant communication.

Common headers:

```http
x-user-id
x-business-id
x-user-type
```

### Common Chat Error

If the API returns:

```json
{
  "success": false,
  "message": "Not allowed"
}
```

Possible causes:

* Wrong `x-user-id`
* Wrong `x-business-id`
* Wrong `x-user-type`
* Conversation does not exist
* User does not belong to the conversation
* Merchant is trying to access another merchant’s conversation

Recommended checks:

* Verify conversation ownership
* Create conversation if it does not exist
* Confirm user ID and business ID before fetching messages

---

## 16. Notifications

The backend supports Expo push notifications.

Example environment variable:

```env
EXPO_NOTIFICATION_URL=https://backend.tabdhey.bt/expo/api/push/send
```

Notification flow:

1. Mobile app registers Expo push token.
2. Backend stores the token.
3. Backend sends notification on order, chat, or status events.
4. Mobile app receives the notification.
5. Notification is marked as read after user interaction.

---

## 17. Database

The backend uses MySQL.

Example database configuration:

```js
{
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306
}
```

Recommended production practices:

* Use connection pooling.
* Avoid hardcoded credentials.
* Keep DB password in Kubernetes Secret or environment variable.
* Back up the database regularly.
* Add indexes for frequently queried fields.

Recommended indexes:

```txt
order_id
business_id
user_id
conversation_id
created_at
status
```

---

## 18. Kubernetes Deployment

Example Kubernetes files:

```txt
k8s/
├── deployment.yaml
├── service.yaml
├── configmap.yaml
├── secret.yaml
└── ingress.yaml
```

### ConfigMap Example

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tabdey-backend-env
  namespace: prod
data:
  NODE_ENV: "production"
  PORT: "3000"
  MEDIA_BASE_URL: "https://backend.tabdhey.bt"
  UPLOAD_DIR: "uploads/chat"
  MAX_IMAGE_BYTES: "8388608"
  DB_HOST: "your-db-host"
  DB_USER: "root"
  DB_NAME: "Superapp_production"
  DB_PORT: "3306"
```

### Secret Example

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: tabdey-backend-secret
  namespace: prod
type: Opaque
stringData:
  DB_PASSWORD: "your-db-password"
  JWT_SECRET: "your-jwt-secret"
  SMTP_USER: "your-email"
  SMTP_PASS: "your-email-password"
```

Apply Kubernetes files:

```bash
kubectl apply -f k8s/
```

Check pods:

```bash
kubectl get pods -n prod
```

View logs:

```bash
kubectl logs -f deployment/tabdey-backend -n prod
```

---

## 19. Docker

Build image:

```bash
docker build -t tabdey-backend .
```

Run container:

```bash
docker run -p 3000:3000 --env-file .env tabdey-backend
```

Example `Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
```

---

## 20. Logs and Monitoring

Recommended logs:

* API request logs
* Authentication logs
* Order status change logs
* Payment logs
* Chat message logs
* Notification logs
* Email sending logs
* Error logs

Avoid logging:

* Passwords
* JWT tokens
* OTPs
* Payment credentials
* Sensitive customer information

Check server storage:

```bash
sudo du -h --max-depth=1 / 2>/dev/null | sort -hr
```

Check `/var` storage:

```bash
sudo du -h --max-depth=1 /var 2>/dev/null | sort -hr
```

Recommended log handling:

* Enable log rotation.
* Archive old logs.
* Avoid storing unnecessary debug logs in production.
* Use centralized logging for large-scale deployments.

---

## 21. Error Handling

Recommended error response:

```json
{
  "success": false,
  "message": "Error message"
}
```

Recommended success response:

```json
{
  "success": true,
  "data": {}
}
```

Common HTTP status codes:

| Status Code | Meaning               |
| ----------- | --------------------- |
| 200         | Success               |
| 201         | Created               |
| 400         | Bad Request           |
| 401         | Unauthorized          |
| 403         | Forbidden             |
| 404         | Not Found             |
| 409         | Conflict              |
| 422         | Validation Error      |
| 500         | Internal Server Error |

---

## 22. Security Checklist

Before production deployment:

* [ ] Remove hardcoded passwords.
* [ ] Use HTTPS.
* [ ] Enable JWT validation.
* [ ] Validate request bodies.
* [ ] Sanitize uploaded files.
* [ ] Restrict upload file types.
* [ ] Set maximum upload size.
* [ ] Protect admin APIs.
* [ ] Use environment variables.
* [ ] Use Kubernetes Secrets for sensitive values.
* [ ] Disable detailed stack traces in production.
* [ ] Do not expose `.env`.
* [ ] Do not commit uploaded files.
* [ ] Enable database backups.
* [ ] Add rate limiting for login and OTP APIs.

---

## 23. Troubleshooting

### SMTP Email Not Sending

Check:

```env
SMTP_HOST
SMTP_PORT
SMTP_USER
SMTP_PASS
SMTP_FROM
```

For Gmail:

* Use app password.
* Do not use normal Gmail password.
* Make sure SMTP access is allowed.

### Uploaded Image Not Showing

Check:

* File exists in upload folder.
* Static route is configured.
* `MEDIA_BASE_URL` is correct.
* Nginx is serving the upload path.
* File permission allows reading.

### Database Connection Failed

Check:

* DB host
* DB port
* DB user
* DB password
* DB name
* Firewall rules
* MySQL user permission

### 403 Not Allowed in Chat

Check:

* Conversation exists.
* Correct `x-user-id`.
* Correct `x-business-id`.
* Correct `x-user-type`.
* User or merchant belongs to the conversation.

### PDF Receipt Not Generated

Check:

* Required order fields are present.
* Items array is not empty.
* Amount fields are numeric.
* PDF service is imported correctly.
* Logo URL is accessible.

---

## 24. Recommended NPM Scripts

Example `package.json` scripts:

```json
{
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "lint": "eslint .",
    "test": "jest"
  }
}
```

---

## 25. Versioning

Recommended version format:

```txt
v1.0.0
```

Example version history:

```txt
v1.0.0 - Initial backend service release
v1.1.0 - Added pickup receipt email
v1.2.0 - Added merchant-user chat improvements
```

---

## 26. Maintainers

```txt
TàbDey Backend Team
New Edge Technology Pvt. Ltd.
Bhutan
```

---

## 27. License

This project is private and proprietary.

Unauthorized copying, modification, distribution, or use of this backend service is strictly prohibited unless written permission is granted by the project owner.

---

## 28. Notes for Developers

When adding a new feature:

1. Create or update the route file.
2. Add controller logic.
3. Add model/database logic.
4. Validate request body.
5. Add authentication and authorization if required.
6. Test with Postman or frontend app.
7. Add logs for important actions.
8. Update this README if new environment variables or APIs are added.

When updating order-related logic, check:

* Normal order flow
* Scheduled order flow
* Pickup order flow
* Delivery order flow
* Merchant notification
* Customer notification
* Email receipt
* PDF receipt
* Grouped order response

---

## 29. Production Checklist

Before pushing to production:

* [ ] Code tested locally.
* [ ] `.env` values verified.
* [ ] Database migration completed.
* [ ] Upload folder mounted or preserved.
* [ ] Email service tested.
* [ ] Notification service tested.
* [ ] Order flow tested.
* [ ] Chat flow tested.
* [ ] Admin APIs tested.
* [ ] Kubernetes pods restarted.
* [ ] Logs checked after deployment.
* [ ] Mobile app API base URL confirmed.

---

## 30. Contact

For internal technical support, contact the backend development team.
