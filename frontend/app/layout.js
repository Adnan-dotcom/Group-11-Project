import "./globals.css";

export const metadata = {
  title: "AuraGen — Self-Healing Generative UI",
  description:
    "Real-time cognitive load telemetry that morphs the UI before users give up.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-950 text-white antialiased">
        {children}
      </body>
    </html>
  );
}
