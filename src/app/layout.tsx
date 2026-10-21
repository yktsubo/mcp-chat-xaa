import { Geist } from 'next/font/google';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata = { title: 'MCP Chat' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={cn('h-full font-sans antialiased', geist.variable)}>
      <body className="flex h-dvh flex-col bg-muted/40">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
