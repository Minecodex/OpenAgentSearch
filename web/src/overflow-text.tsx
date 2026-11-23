import { Tooltip } from "@heroui/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function OverflowText({children, className = ""}: {children: string; className?: string}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const measure = () => {
    const node = ref.current;
    setOverflow(!!node && node.scrollWidth > node.clientWidth + 1);
  };
  useLayoutEffect(measure, [children]);
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    if(ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return (
    <Tooltip isOpen={overflow && (hovered || focused)} onOpenChange={open=>{if(!open){setHovered(false);setFocused(false)}}}>
      <Tooltip.Trigger<"span">
        className="overflow-trigger" render={props => <span {...props}/>}
        tabIndex={overflow ? 0 : undefined}
        onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)}
        onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}
      ><span ref={ref} className={"overflow-text " + className}>{children}</span></Tooltip.Trigger>
      <Tooltip.Content className="overflow-tooltip">{children}</Tooltip.Content>
    </Tooltip>
  );
}
