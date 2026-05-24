def fetch_raw_data():
    """임시 데이터를 가져옵니다."""
    print("Fetching raw data...")
    return " { 'data': 'raw_value' } "

def clean_data(raw_data):
    """데이터를 전처리하고 정제합니다."""
    print(f"Cleaning: {raw_data}")
    return raw_data.strip()

def process_data(raw_data):
    """전체 데이터 처리 흐름을 제어합니다."""
    print("Processing started...")
    cleaned = clean_data(raw_data)
    # 다른 서브 함수 호출 예시
    result = transform_format(cleaned)
    return result

def transform_format(data):
    """포맷을 변환합니다."""
    print("Transforming format...")
    return data.upper()

def save_results(result):
    """결과를 저장합니다."""
    print(f"Saving: {result}")
    write_to_db(result)

def write_to_db(result):
    """DB에 작성합니다."""
    print("Writing database record...")

def main():
    """메인 실행 함수"""
    raw = fetch_raw_data()
    processed = process_data(raw)
    save_results(processed)

if __name__ == "__main__":
    main()
