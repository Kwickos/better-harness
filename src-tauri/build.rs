use std::path::Path;
use std::process::Command;

/// Compile le pont vers le simulateur iOS, embarqué à côté de l'exécutable (`externalBin`).
/// Il est toujours universel (Apple Silicon + Intel, macOS 13 minimum) : le même fichier sert au
/// build de la machine et au bundle `universal-apple-darwin` des releases.
/// Sans Xcode, un exécutable de remplacement dit pourquoi : l'app se construit quand même.
fn build_sim_bridge() {
    let source = "helper/sim-bridge.swift";
    println!("cargo:rerun-if-changed={source}");
    let triple = std::env::var("TARGET").unwrap();
    std::fs::create_dir_all("binaries").unwrap();
    let outputs = [format!("binaries/sim-bridge-{triple}"), "binaries/sim-bridge-universal-apple-darwin".to_string()];
    let up_to_date = |output: &str| -> Option<bool> { Some(Path::new(output).metadata().ok()?.modified().ok()? >= Path::new(source).metadata().ok()?.modified().ok()?) };
    if outputs.iter().all(|o| up_to_date(o) == Some(true)) {
        return;
    }
    let out_dir = std::env::var("OUT_DIR").unwrap();
    let slices: Vec<String> = ["arm64", "x86_64"].iter().map(|arch| format!("{out_dir}/sim-bridge-{arch}")).collect();
    let compiled = ["arm64", "x86_64"].iter().zip(&slices).all(|(arch, slice)| {
        Command::new("xcrun")
            .args(["swiftc", "-O", "-target", &format!("{arch}-apple-macos13.0"), "-o", slice, source])
            .status()
            .is_ok_and(|status| status.success())
    });
    let built = compiled
        && Command::new("xcrun")
            .args(["lipo", "-create", "-output", &outputs[0], &slices[0], &slices[1]])
            .status()
            .is_ok_and(|status| status.success());
    if built {
        std::fs::copy(&outputs[0], &outputs[1]).unwrap();
        return;
    }
    println!("cargo:warning=sim-bridge non compilé (Xcode absent ?) : l'onglet Simulateur sera indisponible");
    for output in &outputs {
        std::fs::write(output, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(output, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
}

fn main() {
    build_sim_bridge();
    tauri_build::build()
}
