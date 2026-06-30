// services/pickupEmailService.js
const nodemailer = require("nodemailer");
const PDFReceiptService = require("./pdfReceiptService");

class PickupEmailService {
  constructor() {
    const emailUser = process.env.EMAIL_USER || process.env.SMTP_USER;
    const emailPass = process.env.EMAIL_PASS || process.env.SMTP_PASS;

    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: emailUser,
        pass: emailPass,
      },
      tls: {
        rejectUnauthorized: false,
      },
    });
  }

  getAddressOnly(value) {
    if (!value) return "N/A";

    // Case 1: pickup_address is already an object:
    // { address: "Thimphu, Near Clock Tower", lat: 27.472, lng: 89.639 }
    if (typeof value === "object") {
      return value.address || "N/A";
    }

    // Case 2: pickup_address is a JSON string:
    // '{"address":"Thimphu, Near Clock Tower","lat":27.472,"lng":89.639}'
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);

        if (parsed && typeof parsed === "object") {
          return parsed.address || value;
        }

        return value;
      } catch (e) {
        // Normal plain text address
        return value;
      }
    }

    return "N/A";
  }

  async sendPickupReceipt(orderData) {
    try {
      console.log("📧 Preparing pickup confirmation email...");

      const pickupLocationText =
        this.getAddressOnly(orderData.pickup_address) ||
        this.getAddressOnly(orderData.business_address) ||
        "N/A";

      // ✅ Transform pickup orderData to match what PDF service expects
      const pdfCompatibleData = {
        // Required by PDF service
        order_id: orderData.order_id,
        customer_name: orderData.customer_name,
        customer_email: orderData.customer_email,
        customer_phone: orderData.customer_phone || "N/A",
        business_name: orderData.business_name,
        business_logo: orderData.business_logo,
        business_address: orderData.business_address,
        payment_method: orderData.payment_method,
        status: "PICKEDUP",
        items: orderData.items,
        subtotal: orderData.subtotal,
        grand_total: orderData.grand_total,

        // ✅ PDF service expects delivery_address
        // For pickup orders, send only the address text, not lat/lng object
        delivery_address: pickupLocationText,

        // PDF service expects delivered_at
        // For pickup orders, use pickedup_at
        delivered_at:
          orderData.pickedup_at || orderData.created_at || new Date(),

        // ✅ For pickup orders: delivery_fee = 0
        delivery_fee: 0,
        platform_fee: orderData.platform_fee || 0,
        merchant_delivery_fee: 0,
        discount_amount: orderData.discount_amount || 0,
      };

      const pdfBuffer =
        await PDFReceiptService.generateOrderReceipt(pdfCompatibleData);

      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { 
              font-family: Arial, sans-serif; 
              line-height: 1.6; 
              color: #333; 
            }
            .container { 
              max-width: 600px; 
              margin: 0 auto; 
              padding: 20px; 
            }
            .header { 
              background: #FF9800; 
              color: white; 
              padding: 20px; 
              text-align: center; 
            }
            .content { 
              padding: 20px; 
              background: #f9f9f9; 
            }
            .order-details { 
              background: white; 
              padding: 15px; 
              margin: 15px 0; 
              border-radius: 5px; 
            }
            .pickup-info { 
              background: #FFF3E0; 
              padding: 15px; 
              margin: 15px 0; 
              border-radius: 5px; 
              border-left: 4px solid #FF9800; 
            }
            .total { 
              font-size: 18px; 
              font-weight: bold; 
              color: #FF9800; 
            }
            .footer { 
              text-align: center; 
              padding: 20px; 
              font-size: 12px; 
              color: #666; 
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2>🎉 ORDER PICKED UP SUCCESSFULLY!</h2>
              <p>Order #: ${orderData.order_id}</p>
            </div>

            <div class="content">
              <p>Dear ${orderData.customer_name},</p>
              <p>Thank you for picking up your order! We hope you enjoy your purchase.</p>
              
              <div class="pickup-info">
                <h3>📍 Pickup Details</h3>
                <p><strong>Merchant:</strong> ${orderData.business_name}</p>
                <p><strong>Pickup Location:</strong> ${pickupLocationText}</p>
                <p><strong>Picked Up At:</strong> ${
                  orderData.pickedup_at
                    ? new Date(orderData.pickedup_at).toLocaleString()
                    : "N/A"
                }</p>
              </div>
              
              <div class="order-details">
                <h3>Order Summary</h3>
                <p><strong>Order Date:</strong> ${
                  orderData.created_at
                    ? new Date(orderData.created_at).toLocaleString()
                    : "N/A"
                }</p>
                <p><strong>Payment Method:</strong> ${
                  orderData.payment_method || "N/A"
                }</p>
                <p><strong>Total Amount:</strong> Nu. ${Number(
                  orderData.grand_total || 0,
                ).toFixed(2)}</p>
              </div>
              
              <p>Please find attached your order receipt in PDF format.</p>
              <p>Thank you for choosing TàbDey!</p>
            </div>

            <div class="footer">
              <p>This is an automated message, please do not reply.</p>
              <p>&copy; ${new Date().getFullYear()} TàbDey. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `;

      const fromEmail =
        process.env.SMTP_FROM ||
        `"TàbDey" <${process.env.EMAIL_USER || process.env.SMTP_USER}>`;

      const info = await this.transporter.sendMail({
        from: fromEmail,
        to: orderData.customer_email,
        subject: `✅ Order Picked Up Successfully - ${orderData.order_id}`,
        html: htmlContent,
        attachments: [
          {
            filename: `receipt-${orderData.order_id}.pdf`,
            content: pdfBuffer,
            contentType: "application/pdf",
          },
        ],
      });

      console.log(
        `[PICKUP EMAIL] Sent to ${orderData.customer_email}, Message ID: ${info.messageId}`,
      );

      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error("[PICKUP EMAIL ERROR]", error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new PickupEmailService();