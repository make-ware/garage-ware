'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, Database, HardDrive, Shield } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useSetupStatus } from '@/lib/setup/use-setup-status';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export default function Home() {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  // A deployment nobody administers should not open on a marketing page with a
  // sign-in button — the owner has no way from there to the setup flow. The
  // hook seeds fail-safe (claimed, closed), so an unreachable probe shows the
  // landing page rather than sending everyone to /setup.
  const { status, loaded } = useSetupStatus();
  const unclaimed = loaded && !status.claimed;

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.push('/dashboard');
    }
  }, [isAuthenticated, isLoading, router]);

  useEffect(() => {
    if (unclaimed) router.push('/setup');
  }, [unclaimed, router]);

  if (isLoading || isAuthenticated || unclaimed) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-muted/20">
      <div className="container mx-auto px-4 py-16 max-w-4xl">
        <div className="text-center mb-12">
          <h1 className="text-5xl md:text-6xl font-bold mb-6">
            GarageWare
            <span className="block text-primary text-3xl md:text-4xl mt-2">
              S3 cluster control plane
            </span>
          </h1>
          <p className="text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
            Manage buckets, access keys, and storage claims on your Garage HQ
            cluster.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/login">
              <Button size="lg" className="text-lg px-8">
                Sign in <ArrowRight className="ml-2 h-5 w-5" />
              </Button>
            </Link>
            {status.signupMode === 'open' && (
              <Link href="/signup">
                <Button variant="outline" size="lg" className="text-lg px-8">
                  Create account
                </Button>
              </Link>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <FeatureCard
            icon={<Shield className="h-6 w-6" />}
            title="Cluster admin"
            description="Live status, layout, and node health. Ship metrics to Grafana, run the control plane here."
          />
          <FeatureCard
            icon={<Database className="h-6 w-6" />}
            title="Storage claims"
            description="Grant each user a slice of usable capacity (raw / replication factor) and let them allocate it across buckets."
          />
          <FeatureCard
            icon={<HardDrive className="h-6 w-6" />}
            title="Self-serve buckets & keys"
            description="Users manage their own S3 access keys, bucket permissions, and per-bucket quotas."
          />
        </div>
      </div>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 mb-1">
          <div className="text-primary">{icon}</div>
          <CardTitle className="text-lg">{title}</CardTitle>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent />
    </Card>
  );
}
