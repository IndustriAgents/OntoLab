import React from "react";
import FooterLinkItem from "@theme-original/Footer/LinkItem";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import WorkspaceLink from "../../NavbarItem/WorkspaceLink";

export default function LocalFooterLink(props) {
  const { siteConfig } = useDocusaurusContext();
  return siteConfig.customFields.bundledDocs && props.item.label === "Back to workspace" ? (
    <WorkspaceLink className="footer__link-item" label="Back to workspace" />
  ) : (
    <FooterLinkItem {...props} />
  );
}
