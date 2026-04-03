import { createNavigation } from 'next-intl/navigation';
import { locales } from './locales';

export const { Link, redirect, usePathname, useRouter } = createNavigation({ locales });
