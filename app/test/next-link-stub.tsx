// next/link outside Next.js, for the component pages of the tests: a plain link
export default function Link({ href, ...props }: React.ComponentProps<"a"> & { href: string }) {
  return <a href={href} {...props} />;
}
