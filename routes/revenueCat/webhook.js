// routes/revenuecat/revenuecatRoutes.js
import express from "express";
import { handleRevenueCatWebhook } from "../../services/revenueCat/revenueCatServices.js";

const router = express.Router();

/**
 * @route POST /api/revenuecat/webhook
 * @desc Endpoint to receive RevenueCat webhooks
 * @access Public (RevenueCat will call it)
 */
router.post("/webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("💡 RevenueCat webhook received:", event);

    // Handle the webhook in a service
    await handleRevenueCatWebhook(event);

    res
      .status(200)
      .json({ success: true, message: "Webhook received and processed" });
  } catch (error) {
    console.error("❌ RevenueCat webhook error:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

export default router;
