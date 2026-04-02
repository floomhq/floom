export default {
  providers: [
    {
      // Clerk integration — validates Clerk JWTs in Convex
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
  ],
};
