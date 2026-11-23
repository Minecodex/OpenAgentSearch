export const PRODUCT_NAME = "OpenAgentSearch";

export function BrandMark() {
  return (
    <span aria-hidden="true" className="brand-mark">
      <i />
      <i />
      <i />
    </span>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <BrandMark />
      <strong>{PRODUCT_NAME}</strong>
    </div>
  );
}
