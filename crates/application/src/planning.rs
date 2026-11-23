use crate::{cpu, engine::Run};
use oas_domain::{Endpoint, Result, model, tokens};
use serde_json::Value;
impl Run<'_> {
    pub fn model_input(&self, input: &Value) -> Value {
        let mut payload = input.clone();
        payload.as_object_mut().expect("model input object").extend(
            self.query_context
                .as_object()
                .expect("query context object")
                .clone(),
        );
        payload
    }
    pub async fn request_fits(
        &self,
        endpoint: &Endpoint,
        task: &str,
        input: &Value,
    ) -> Result<bool> {
        let (endpoint, task, input) = (endpoint.clone(), task.to_owned(), self.model_input(input));
        self.bounded(cpu::run(&self.cancel, move || {
            model::fits_with_correction(&endpoint, &task, &input)
        }))
        .await
    }
    pub async fn token_count(&self, encoding: &str, input: String) -> Result<usize> {
        let encoding = encoding.to_owned();
        self.bounded(cpu::run(&self.cancel, move || {
            tokens::count(&encoding, &input)
        }))
        .await
    }
}
