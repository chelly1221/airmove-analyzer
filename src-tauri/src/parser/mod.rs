pub mod ass;

use thiserror::Error;

#[derive(Error, Debug)]
pub enum ParseError {
    #[error("Failed to read file: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Invalid file format: {0}")]
    InvalidFormat(String),

    #[error("No records found in file")]
    NoRecords,

    #[error("Record parse error at offset {offset}: {message}")]
    RecordError { offset: usize, message: String },
}
