import "./Brand.css";

/** The product mark; `mark` is the square alone (the nav rail), otherwise with the name. */
export function Brand({ large, mark }: { large?: boolean; mark?: boolean }) {
  if (mark) {
    return (
      <span className="brand__mark brand__mark--solo" role="img" aria-label="Demo Studio">
        D
      </span>
    );
  }
  return (
    <div className={large ? "brand brand--large" : "brand"}>
      <span className="brand__mark" aria-hidden="true" />
      Demo Studio
    </div>
  );
}
