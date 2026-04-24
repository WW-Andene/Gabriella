import "./globals.css";

export const metadata = {
  title:       "Gabriella",
  description: "A chat interface with memory, presence, and interiority.",
  applicationName: "Gabriella",
  appleWebApp: {
    capable:           true,
    title:             "Gabriella",
    statusBarStyle:    "black-translucent",
  },
  icons: {
    icon:         "/icon-192.png",
    shortcut:     "/icon-192.png",
    apple:        "/icon-512.png",
  },
};

export const viewport = {
  themeColor:        "#08080f",
  width:             "device-width",
  initialScale:      1,
  maximumScale:      1,
  viewportFit:       "cover",
  colorScheme:       "dark",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
