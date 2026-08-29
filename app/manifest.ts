import type { MetadataRoute } from 'next';
export default function manifest(): MetadataRoute.Manifest { return { name: 'MyTeam 企业助手', short_name: 'MyTeam', description: '团队即时沟通与公司组织架构管理工具', start_url: '/', display: 'standalone', background_color: '#f5f7fb', theme_color: '#172238', icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] }; }
