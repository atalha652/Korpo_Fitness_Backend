// services/revenuecatService.js
import { db } from "../../firebase.js";
import { doc, getDoc, updateDoc } from "firebase/firestore";

export const handleRevenueCatWebhook = async (payload) => {
  try {
    const subscriberId = payload.event?.original_app_user_id || payload.event?.app_user_id;
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

    const eventType = payload.event.type;

    switch (eventType) {
      case "INITIAL_PURCHASE":
      case "RENEWAL":
      case "UNCANCELLATION": // Added uncancellation handling
        await updateDoc(userRef, {
          plan: "premium",
          upgradedAt: new Date().toISOString(),
        });
        console.log(`✅ User ${subscriberId} upgraded to premium`);
        break;

      case "CANCELLATION":
      case "EXPIRED":
        await updateDoc(userRef, {
          plan: "free",
          downgradedAt: new Date().toISOString(),
        });
        console.log(`⚠️ User ${subscriberId} downgraded to free`);
        break;

      default:
        console.log("ℹ️ Unhandled RevenueCat event type:", eventType);
    }
  } catch (error) {
    console.error("❌ Error handling RevenueCat webhook event:", error);
  }
};