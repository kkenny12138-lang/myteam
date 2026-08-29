import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import './im.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL('https://xiaowuzhi.online'),
  title: 'MyTeam · 企业沟通与组织管理',
  description: '与你的团队即时沟通，管理公司组织架构。',
  applicationName: 'MyTeam',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'MyTeam' },
  icons: { icon: '/favicon.svg', apple: '/og.png' },
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
