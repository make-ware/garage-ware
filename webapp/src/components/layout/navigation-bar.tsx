'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Menu,
  LogOut,
  Settings,
  HardDrive,
  KeyRound,
  ChartLine,
  Server,
  ServerCog,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useIsMobile } from '@/hooks/use-mobile';
import { useFeatures } from '@/lib/setup/use-features';
import { useSetupStatus } from '@/lib/setup/use-setup-status';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

interface NavigationBarProps {
  className?: string;
}

export function NavigationBar({ className }: NavigationBarProps) {
  const { user, isAuthenticated, logout, isLoading } = useAuth();
  const isMobile = useIsMobile();
  const pathname = usePathname();
  // Both hooks seed at the safe default (features off, signups closed), so the
  // gated entries stay hidden until the server says otherwise.
  const { features } = useFeatures();
  const { status: setupStatus } = useSetupStatus();
  const showSignup = setupStatus.signupMode === 'open';

  // Helper function to get user initials for avatar fallback
  const getUserInitials = (name?: string, email?: string) => {
    if (name) {
      return name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);
    }
    if (email) {
      return email[0].toUpperCase();
    }
    return 'U';
  };

  const handleLogout = () => {
    logout();
  };

  // Primary sections, shown inline in the desktop bar
  const primaryLinks = [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/dashboard/metrics', label: 'Metrics' },
    { href: '/dashboard/cluster', label: 'Cluster' },
  ];

  // Navigation links for authenticated users. "My Nodes" only exists when
  // node claiming is enabled on this deployment.
  const authenticatedLinks = [
    { href: '/dashboard', label: 'Dashboard', icon: HardDrive },
    { href: '/dashboard/buckets', label: 'Buckets', icon: HardDrive },
    { href: '/dashboard/keys', label: 'Access Keys', icon: KeyRound },
    { href: '/dashboard/metrics', label: 'Metrics', icon: ChartLine },
    { href: '/dashboard/cluster', label: 'Cluster', icon: Server },
    ...(features.nodeClaims
      ? [{ href: '/dashboard/nodes', label: 'My Nodes', icon: ServerCog }]
      : []),
    { href: '/profile', label: 'Profile', icon: Settings },
  ];

  // Navigation links for unauthenticated users. Sign-up is promoted only when
  // it is genuinely open — invited users arrive via their emailed /signup link.
  const unauthenticatedLinks = [
    { href: '/login', label: 'Login' },
    ...(showSignup ? [{ href: '/signup', label: 'Sign Up' }] : []),
  ];

  return (
    <header
      className={cn(
        'border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60',
        className
      )}
    >
      <div className="flex h-14 w-full items-center px-4">
        {/* Logo/Brand */}
        <div className="mr-4 flex">
          <Link href="/" className="mr-6 flex items-center space-x-2">
            <span className="font-bold text-xl">GarageHQ Console</span>
            {process.env.NEXT_PUBLIC_APP_VERSION && (
              <span className="text-xs text-muted-foreground">
                v{process.env.NEXT_PUBLIC_APP_VERSION}
              </span>
            )}
          </Link>
        </div>

        {/* Desktop Navigation */}
        <div className="flex flex-1 items-center justify-between space-x-2 md:justify-end">
          <div className="w-full flex-1 md:w-auto md:flex-none">
            {!isMobile && isAuthenticated && (
              <nav className="flex items-center gap-1">
                {primaryLinks.map((link) => (
                  <Button
                    key={link.href}
                    variant="ghost"
                    size="sm"
                    asChild
                    className={cn(
                      pathname === link.href
                        ? 'text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <Link href={link.href}>{link.label}</Link>
                  </Button>
                ))}
              </nav>
            )}
          </div>

          {/* Desktop Auth Navigation */}
          {!isMobile && (
            <nav className="flex items-center">
              {isLoading ? (
                <div className="h-8 w-20 animate-pulse bg-muted rounded" />
              ) : isAuthenticated ? (
                <div className="flex items-center gap-4">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        className="relative h-8 w-8 rounded-full"
                      >
                        <Avatar className="h-8 w-8">
                          <AvatarImage
                            src={user?.avatar}
                            alt={user?.name || user?.email}
                          />
                          <AvatarFallback>
                            {getUserInitials(user?.name, user?.email)}
                          </AvatarFallback>
                        </Avatar>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      className="w-56"
                      align="end"
                      forceMount
                    >
                      <DropdownMenuLabel className="font-normal">
                        <div className="flex flex-col space-y-1">
                          <p className="text-sm font-medium leading-none">
                            {user?.name || 'User'}
                          </p>
                          <p className="text-xs leading-none text-muted-foreground">
                            {user?.email}
                          </p>
                        </div>
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {authenticatedLinks.map((link) => (
                        <DropdownMenuItem key={link.href} asChild>
                          <Link href={link.href} className="flex items-center">
                            <link.icon className="mr-2 h-4 w-4" />
                            <span>{link.label}</span>
                          </Link>
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={handleLogout}>
                        <LogOut className="mr-2 h-4 w-4" />
                        <span>Log out</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" asChild>
                    <Link href="/login">Login</Link>
                  </Button>
                  {showSignup && (
                    <Button asChild>
                      <Link href="/signup">Sign Up</Link>
                    </Button>
                  )}
                </div>
              )}
            </nav>
          )}

          {/* Mobile Navigation */}
          {isMobile && (
            <Sheet>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  className="mr-2 px-0 text-base hover:bg-transparent focus-visible:bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 md:hidden"
                >
                  <Menu className="h-5 w-5" />
                  <span className="sr-only">Toggle Menu</span>
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="pr-0">
                <SheetHeader>
                  <SheetTitle>Navigation</SheetTitle>
                </SheetHeader>
                <div className="flex flex-col space-y-4 p-4">
                  {isAuthenticated ? (
                    <>
                      <div className="flex items-center space-x-4 pb-4 border-b">
                        <Avatar className="h-12 w-12">
                          <AvatarImage
                            src={user?.avatar}
                            alt={user?.name || user?.email}
                          />
                          <AvatarFallback>
                            {getUserInitials(user?.name, user?.email)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex flex-col">
                          <p className="text-sm font-medium">
                            {user?.name || 'User'}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {user?.email}
                          </p>
                        </div>
                      </div>
                      {authenticatedLinks.map((link) => (
                        <Button
                          key={link.href}
                          variant="ghost"
                          className="justify-start"
                          asChild
                        >
                          <Link href={link.href}>
                            <link.icon className="mr-2 h-4 w-4" />
                            {link.label}
                          </Link>
                        </Button>
                      ))}
                      <Button
                        variant="ghost"
                        className="justify-start"
                        onClick={handleLogout}
                      >
                        <LogOut className="mr-2 h-4 w-4" />
                        Log out
                      </Button>
                    </>
                  ) : (
                    <>
                      {unauthenticatedLinks.map((link) => (
                        <Button
                          key={link.href}
                          variant="ghost"
                          className="justify-start"
                          asChild
                        >
                          <Link href={link.href}>{link.label}</Link>
                        </Button>
                      ))}
                    </>
                  )}
                </div>
              </SheetContent>
            </Sheet>
          )}
        </div>
      </div>
    </header>
  );
}
