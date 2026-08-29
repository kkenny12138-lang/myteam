import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL('https://myteam-command-center.openai.site'),
  title: 'MyTeam · 智能团队指挥中心',
  description: '把目标交给虚拟团队，由中控大脑拆解并分派给专业顾问。',
  openGraph: {
    title: 'MyTeam · 智能团队指挥中心',
    description: 'CEO 拆解总指令，专业顾问协同执行。',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'MyTeam · 智能团队指挥中心',
    description: 'CEO 拆解总指令，专业顾问协同执行。',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>{children}</body></html>;
}
