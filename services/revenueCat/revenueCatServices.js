// services/revenuecatService.js
import { db } from "../../firebase.js";
import { doc, getDoc, updateDoc } from "firebase/firestore";

/**
 * Handle RevenueCat webhook events
 */
export const handleRevenueCatWebhook = async (event) => {
  try {
    const subscriberId = event.subscriber?.original_app_user_id;
    if (!subscriberId) {
      console.log("⚠️ RevenueCat event missing subscriberId, skipping");
      return;
    }

    // Reference to Firestore user
    const userRef = doc(db, "users", subscriberId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      console.log(`⚠️ No user found with UID ${subscriberId}, skipping`);
      return;
    }

    switch (event.type) {
      case "INITIAL_PURCHASE":
      case "RENEWAL":
        // Upgrade user to premium
        await updateDoc(userRef, {
          plan: "premium",
          upgradedAt: new Date().toISOString(),
        });
        console.log(`✅ User ${subscriberId} upgraded to premium`);
        break;

      case "CANCELLATION":
      case "EXPIRED":
        // Downgrade user to free
        await updateDoc(userRef, {
          plan: "free",
          downgradedAt: new Date().toISOString(),
        });
        console.log(`⚠️ User ${subscriberId} downgraded to free`);
        break;

      default:
        console.log("ℹ️ Unhandled RevenueCat event type:", event.type);
    }
  } catch (error) {
    console.error("❌ Error handling RevenueCat webhook event:", error);
  }
};
