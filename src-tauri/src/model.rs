use serde::Serialize;

pub const MAX_ENVELOPE: usize = 10 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
}
pub type Result<T> = std::result::Result<T, AppError>;
pub fn error(code: &str, message: &str) -> AppError {
    AppError {
        code: code.into(),
        message: message.into(),
    }
}
pub fn storage_error(_: impl std::fmt::Display) -> AppError {
    error(
        "storage_error",
        "Local storage could not complete the operation. Your prior library is retained; retry.",
    )
}
