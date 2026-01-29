/**
 * Setup Script for Stripe Products
 * Run this once to create the required products and prices in Stripe
 * 
 * Usage: node scripts/setupStripeProducts.js
 */

import dotenv from 'dotenv';
import { createStripeProducts } from '../services/stripe/subscriptionService.js';

dotenv.config();

async function setupProducts() {
  try {
    console.log('🚀 Setting up Stripe products...');
    
    const products = await createStripeProducts();
    
    console.log('\n✅ Stripe products created successfully!');
    console.log('\n📝 Add these to your .env file:');
    console.log(`STRIPE_PLATFORM_PRICE_ID=${products.platformPrice}`);
    console.log(`STRIPE_USAGE_PRICE_ID=${products.usagePrice}`);
    console.log(`STRIPE_PLATFORM_PRODUCT_ID=${products.platformProduct}`);
    console.log(`STRIPE_USAGE_PRODUCT_ID=${products.usageProduct}`);
    
    console.log('\n🔧 Next steps:');
    console.log('1. Add the above environment variables to your .env file');
    console.log('2. Update your webhook endpoint in Stripe Dashboard');
    console.log('3. Test the subscription flow');
    
  } catch (error) {
    console.error('❌ Error setting up products:', error);
    process.exit(1);
  }
}

setupProducts();