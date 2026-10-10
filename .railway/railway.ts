// OpenStudio Personal on Railway: the kernel and the control plane as two
// services built from the one Dockerfile, each keeping its state on a volume.
//
//   railway config plan
//   railway config apply
//
// Not in this file, because Railway does not take them from it: a generated
// domain for each service, and the two secrets. See docs/running.md.
import { defineRailway, preserve, project, service, volume } from "railway/iac";

const build = { builder: "DOCKERFILE" as const, dockerfilePath: "Dockerfile" };

export default defineRailway(() => {
  const kernelState = volume("kernel-state");
  const controlData = volume("control-data");

  // The browser loads pieces straight from the kernel, so it is public too.
  // Everything it answers is signed or ticketed with KERNEL_SECRET.
  const kernel = service("kernel", {
    build,
    start: "serve-kernel",
    healthcheck: "/.well-known/celld/health",
    env: {
      KERNEL_SECRET: preserve(),
      CONTROL_URL: "https://${{control.RAILWAY_PUBLIC_DOMAIN}}",
    },
    volumeMounts: { "/app/kernel/.celld": kernelState },
  });

  const control = service("control", {
    build,
    start: "npm --prefix control start",
    // The stylesheet: the one page that answers without the secret.
    healthcheck: "/app.css",
    env: {
      HOST: "0.0.0.0",
      OPENSTUDIO_SECRET: preserve(),
      OPENSTUDIO_DATA: "/data",
      OPENSTUDIO_URL: "https://${{RAILWAY_PUBLIC_DOMAIN}}",
      KERNEL_URL: "https://${{kernel.RAILWAY_PUBLIC_DOMAIN}}",
      KERNEL_SECRET: kernel.env.KERNEL_SECRET,
    },
    volumeMounts: { "/data": controlData },
  });

  return project("openstudio-personal", { resources: [kernel, control, kernelState, controlData] });
});
