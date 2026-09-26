// Desktop entry point, for trying the app on a computer; Android starts from lib.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    teamsrelay_mobile_lib::run()
}
