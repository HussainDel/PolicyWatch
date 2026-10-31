import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'PolicyWatch',description:'Evidence-backed policy intelligence'};
export default function Layout({children}:{children:React.ReactNode}) {return <html lang="en"><body>{children}</body></html>;}
