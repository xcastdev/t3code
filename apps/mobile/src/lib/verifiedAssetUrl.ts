import {
  markVerificationRequired,
  verificationRequiredFor,
  verifiedRouteFor,
} from "../connection/verified-route";

export function issuedMobileTransferUrl(
  environmentId: string,
  issuedUrl: string,
  verificationRequired = false,
): string | null {
  let url: URL;
  try {
    url = new URL(issuedUrl);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    return null;
  }
  if (verificationRequired) markVerificationRequired(url.origin);
  const binding = verifiedRouteFor(url.origin);
  if (binding !== undefined) return binding.environmentId === environmentId ? issuedUrl : null;
  return verificationRequiredFor(url.origin) ? null : issuedUrl;
}

export function issuedMobileAssetUrl(
  environmentId: string,
  asset: {
    readonly relativeUrl: string;
    readonly learnedRoute?: boolean;
    readonly verificationRequired?: true;
  },
): string | null {
  return issuedMobileTransferUrl(
    environmentId,
    asset.relativeUrl,
    asset.verificationRequired || asset.learnedRoute,
  );
}
