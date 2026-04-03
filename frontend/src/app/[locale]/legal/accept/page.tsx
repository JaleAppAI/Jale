'use client';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import LegalWall from '@/components/legal/LegalWall';

export default function LegalAcceptPage() {
    useRequireAuth();

    return (
        <main>
            <LegalWall />
        </main>
    );
}
