import { LoginForm } from "./login-form";

type LoginPageProps = {
  searchParams: Promise<{
    redirectedFrom?: string | string[];
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const redirectedFrom = Array.isArray(params.redirectedFrom)
    ? params.redirectedFrom[0]
    : params.redirectedFrom;

  return <LoginForm redirectedFrom={redirectedFrom} />;
}
