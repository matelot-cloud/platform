import { useContext } from "react";
import { HelmetProvider, Helmet } from "react-helmet-async";
import { InAppLayout } from "@/platform/navigation/ScopeHeader";

const PageMeta = ({
  title,
  description,
}: {
  title: string;
  description: string;
}) => {
  // inside the app layout the tab title names the scope (ScopeDocumentTitle); standalone pages keep their own
  const inApp = useContext(InAppLayout);
  return (
    <Helmet>
      {!inApp && <title>{title}</title>}
      <meta name="description" content={description} />
    </Helmet>
  );
};

export const AppWrapper = ({ children }: { children: React.ReactNode }) => (
  <HelmetProvider>{children}</HelmetProvider>
);

export default PageMeta;
