public with sharing class OrderController {
    public static void getOrders() {
        ItemService.fetchItems();
        PaymentService.pay();
        System.debug(Label.Order_Title);
        Invoice__c invoice = new Invoice__c();
        invoice.Amount__c = 10;
        App_Config__mdt configRow;
    }
}
