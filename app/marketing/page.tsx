export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-white px-4">
      <h1 className="text-5xl font-bold tracking-tight text-gray-900">
        Floom
      </h1>
      <p className="mt-4 max-w-md text-center text-lg text-gray-600">
        Deploy and share Python automations with your team
      </p>
      <a
        href="https://dashboard.floom.dev/sign-up"
        className="mt-8 rounded-lg bg-gray-900 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-gray-700"
      >
        Get Started
      </a>
    </div>
  );
}
