// services/revenuecatService.js
import { db } from "../../firebase.js";
import {
  doc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs,
  addDoc,
  increment,
  Timestamp,
} from "firebase/firestore";

const REFERRAL_DISCOUNT_RATE = 0.1;

function getEventAmount(event) {
  const amount = event.price_in_purchased_currency ?? event.price;
  return typeof amount === "number" && amount > 0 ? amount : 0;
}

function getEventTransactionId(event) {
  return event.transaction_id || event.id || null;
}

async function findPromoDoc(promoCode) {
  const promoCodesRef = collection(db, "promoCodes");
  const promoQuery1 = query(promoCodesRef, where("code", "==", promoCode));
  let promoSnap = await getDocs(promoQuery1);

  if (promoSnap.empty) {
    const promoQuery2 = query(promoCodesRef, where("promoCode", "==", promoCode));
    promoSnap = await getDocs(promoQuery2);
  }

  return promoSnap.empty ? null : promoSnap.docs[0];
}

async function processPartnerCommission(userId, user, finalAmount, transactionId) {
  const trackingQuery = query(
    collection(db, "partnerTracking"),
    where("revenueCatTransactionId", "==", transactionId)
  );
  const trackingSnap = await getDocs(trackingQuery);

  if (!trackingSnap.empty) {
    console.log(`⚠️ Partner commission for RevenueCat transaction ${transactionId} already processed.`);
    return;
  }

  const promoDoc = await findPromoDoc(user.promoCodeUsed);
  if (!promoDoc) {
    console.log(`⚠️ Promo code ${user.promoCodeUsed} not found, skipping commission.`);
    return;
  }

  const promoData = promoDoc.data();
  const partnerId = promoData.partnerId;
  if (!partnerId) return;

  const now = new Date();
  const validTo = promoData.validTo?.toDate
    ? promoData.validTo.toDate()
    : promoData.validTo
      ? new Date(promoData.validTo)
      : new Date(8640000000000000);
  const validFrom = promoData.validFrom?.toDate
    ? promoData.validFrom.toDate()
    : promoData.validFrom
      ? new Date(promoData.validFrom)
      : new Date(0);

  if (promoData.status !== "active" || now > validTo || now < validFrom) {
    console.log(`⚠️ Promo code ${user.promoCodeUsed} is expired or inactive, skipping commission.`);
    return;
  }

  const partnerRef = doc(db, "partners", partnerId);
  const partnerSnap = await getDoc(partnerRef);
  if (!partnerSnap.exists()) return;

  const partnerData = partnerSnap.data();
  const commissionRate = partnerData.commissionRate ?? 0.2;
  const discountRate = partnerData.discountRate ?? promoData.discountRate ?? 0;
  const originalAmount = discountRate > 0 ? finalAmount / (1 - discountRate) : finalAmount;
  const commissionEarned = finalAmount * commissionRate;
  const companyRevenue = finalAmount - commissionEarned;

  await updateDoc(partnerRef, {
    availableBalance: increment(commissionEarned),
    totalPartnerRevenue: increment(commissionEarned),
    totalPromos: increment(1),
    updatedAt: Timestamp.fromDate(new Date()),
  });

  await addDoc(collection(db, "partnerTracking"), {
    companyRevenue,
    discountAmount: originalAmount - finalAmount,
    discountPercentage: discountRate,
    finalAmount,
    originalAmount,
    partnerId,
    partnerRevenue: commissionEarned,
    partnerSharePercentage: commissionRate,
    promoCode: user.promoCodeUsed,
    promoId: promoDoc.id,
    usedAt: Timestamp.fromDate(new Date()),
    userId,
    revenueCatTransactionId: transactionId,
    source: "revenuecat",
  });

  console.log(`✅ Partner ${partnerId} rewarded with $${commissionEarned} commission (RevenueCat).`);
}

async function processAmbassadorCommission(userId, user, finalAmount, transactionId) {
  const trackingQuery = query(
    collection(db, "referralTracking"),
    where("revenueCatTransactionId", "==", transactionId)
  );
  const trackingSnap = await getDocs(trackingQuery);

  if (!trackingSnap.empty) {
    console.log(`⚠️ Ambassador commission for RevenueCat transaction ${transactionId} already processed.`);
    return;
  }

  const referralCodesRef = collection(db, "referralCodes");
  const refQuery = query(referralCodesRef, where("referralCode", "==", user.referralUsed));
  const refSnap = await getDocs(refQuery);
  if (refSnap.empty) return;

  const refData = refSnap.docs[0].data();
  const referralId = refSnap.docs[0].id;
  const ambassadorId = refData.ambassadorId;

  const now = new Date();
  const validTo = refData.validTo?.toDate
    ? refData.validTo.toDate()
    : refData.validTo
      ? new Date(refData.validTo)
      : new Date(8640000000000000);
  const validFrom = refData.validFrom?.toDate
    ? refData.validFrom.toDate()
    : refData.validFrom
      ? new Date(refData.validFrom)
      : new Date(0);

  if (!ambassadorId || refData.status !== "active" || now > validTo || now < validFrom) {
    console.log(`⚠️ Referral code ${user.referralUsed} is expired or inactive, skipping commission.`);
    return;
  }

  const ambassadorRef = doc(db, "ambassadors", ambassadorId);
  const ambassadorSnap = await getDoc(ambassadorRef);
  if (!ambassadorSnap.exists()) return;

  const ambassadorData = ambassadorSnap.data();
  const commissionRate = ambassadorData.commissionRate ?? 0.1;
  const originalAmount = finalAmount / (1 - REFERRAL_DISCOUNT_RATE);
  const commissionEarned = originalAmount * commissionRate;

  await updateDoc(ambassadorRef, {
    availableBalance: increment(commissionEarned),
    totalReferrals: increment(1),
    updatedAt: Timestamp.fromDate(new Date()),
  });

  await updateDoc(doc(db, "referralCodes", referralId), {
    timesUsed: increment(1),
  });

  await addDoc(collection(db, "referralTracking"), {
    ambassadorId,
    amount: originalAmount,
    commissionEarned,
    commissionRate,
    referralCode: user.referralUsed,
    referralId,
    usedAt: Timestamp.fromDate(new Date()),
    userId,
    revenueCatTransactionId: transactionId,
    source: "revenuecat",
  });

  console.log(`✅ Ambassador ${ambassadorId} rewarded with $${commissionEarned} commission (RevenueCat).`);
}

async function processPromoReferralCommission(userId, user, event) {
  const finalAmount = getEventAmount(event);
  const transactionId = getEventTransactionId(event);

  if (!transactionId) {
    console.log("⚠️ RevenueCat event missing transaction id, skipping commission.");
    return;
  }

  if (finalAmount <= 0) {
    console.log("⚠️ RevenueCat event has no paid amount, skipping commission.");
    return;
  }

  if (user.promoCodeUsed) {
    await processPartnerCommission(userId, user, finalAmount, transactionId);
  } else if (user.referralUsed) {
    await processAmbassadorCommission(userId, user, finalAmount, transactionId);
  }
}

export const handleRevenueCatWebhook = async (payload) => {
  try {
    const event = payload.event;
    const subscriberId = event?.original_app_user_id || event?.app_user_id;
    if (!subscriberId) {
      console.log("⚠️ RevenueCat event missing subscriberId, skipping");
      return;
    }

    const userRef = doc(db, "users", subscriberId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      console.log(`⚠️ No user found with UID ${subscriberId}, skipping`);
      return;
    }

    const user = userSnap.data();
    const eventType = event.type;

    switch (eventType) {
      case "INITIAL_PURCHASE":
      case "RENEWAL":
      case "UNCANCELLATION":
        await updateDoc(userRef, {
          plan: "premium",
          upgradedAt: new Date().toISOString(),
        });
        console.log(`✅ User ${subscriberId} upgraded to premium`);

        if (eventType === "INITIAL_PURCHASE") {
          try {
            await processPromoReferralCommission(subscriberId, user, event);
          } catch (commissionError) {
            console.error("❌ Error applying promo/referral commission (RevenueCat):", commissionError);
          }
        }
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
